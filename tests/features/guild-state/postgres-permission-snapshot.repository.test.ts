import { describe, expect, it } from "vitest";
import type { DiscordIdentifier } from "../../../src/features/guild-state/models/domain/discord-identifier.js";
import {
	InvalidDiscordIdentifierError,
	InvalidPermissionBitfieldError
} from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import { PostgresPermissionSnapshotRepository } from "../../../src/features/guild-state/repositories/postgres-permission-snapshot.repository.js";
import type { SqlClientSession, SqlExecutor } from "../../../src/features/guild-state/repositories/sql-executor.js";

/**
 * The snapshot adapter's promises, proven without a server (docs/features/guild-state.md Contracts: "one read
 * transaction or one joined query"; R1, R3, R13, R14). The SQL's behaviour on real rows — ordering, isolation
 * under a concurrent writer, the six statements' actual results — is proven in
 * `tests/integration/guild-state-effective-permissions.integration.test.ts`. What this file pins is the shape
 * of the calls, which a database shows only expensively:
 *
 * - every statement runs on ONE checked-out session inside one transaction, so the projection is one instant
 *   of the registry rather than six independent ones (a torn permission result is the defect ADR 0005 rejects);
 * - the isolation level is pinned before the first read, because a plain BEGIN is READ COMMITTED, where each
 *   statement takes a fresh snapshot;
 * - every statement binds the Guild id and passes no value into the statement text (R1, persistence.md);
 * - nothing writes (R13), and only channel display metadata needed by the accessible list is selected;
 * - stored ids and bitfield text are validated on the way out, so a driver that ever handed back a number is
 *   refused here instead of being rounded by the derivation (R3).
 */

const GUILD: DiscordIdentifier = "160000000000000001";
const USER: DiscordIdentifier = "160000000000000101";
const CHANNEL: DiscordIdentifier = "160000000000000201";
const PARENT: DiscordIdentifier = "160000000000000202";

/** The rows a real PostgreSQL answers each statement with, keyed by a marker in the statement text. */
interface FixtureRows {
	guild?: readonly Record<string, unknown>[];
	membership?: readonly Record<string, unknown>[];
	roles?: readonly Record<string, unknown>[];
	channels?: readonly Record<string, unknown>[];
	overwrites?: readonly Record<string, unknown>[];
	threadMembers?: readonly Record<string, unknown>[];
}

const MARKERS: readonly (readonly [string, keyof FixtureRows])[] = [
	["FROM guild\n", "guild"],
	["FROM guild_membership AS m", "membership"],
	["FROM guild_role AS role", "roles"],
	["FROM channel_permission_overwrite", "overwrites"],
	["FROM channel\n", "channels"],
	["FROM thread_membership", "threadMembers"]
];

const DEFAULT_ROWS: Required<FixtureRows> = {
	guild: [{ guild_id: GUILD, guild_name: "Test guild" }],
	membership: [{ guild_id: GUILD, user_id: USER, role_ids: [PARENT] }],
	roles: [
		{ role_id: GUILD, permissions_bitfield: "1024" },
		{ role_id: PARENT, permissions_bitfield: "65536" }
	],
	channels: [
		{
			channel_id: CHANNEL,
			guild_id: GUILD,
			channel_type: "public-thread",
			channel_name: "Registry thread",
			channel_position: 1,
			parent_channel_id: PARENT
		},
		{
			channel_id: PARENT,
			guild_id: GUILD,
			channel_type: "guild-text",
			channel_name: null,
			channel_position: 0,
			parent_channel_id: null
		}
	],
	overwrites: [
		{
			channel_id: CHANNEL,
			overwrite_target_id: GUILD,
			overwrite_target_type: "role",
			allow_bitfield: "2048",
			deny_bitfield: "0"
		},
		{
			channel_id: PARENT,
			overwrite_target_id: USER,
			overwrite_target_type: "member",
			allow_bitfield: "0",
			deny_bitfield: "1024"
		}
	],
	threadMembers: [{ thread_id: CHANNEL }]
};

interface RecordedStatement {
	readonly statement: string;
	readonly parameters: readonly unknown[];
}

/** The session double: records, answers by marker, and can be told to break on the next statement. */
class RecordingSession implements SqlClientSession {
	public readonly statements: RecordedStatement[] = [];

	public released = 0;

	public failOnMarker: string | undefined;

	constructor(private readonly rows: Required<FixtureRows>) {}

	public readonly query = async <Row = Record<string, unknown>>(
		statement: string,
		parameters: readonly unknown[] = []
	): Promise<{ rows: Row[] }> => {
		this.statements.push({ statement, parameters });
		const marker = MARKERS.map(([text]) => text).find((text) => statement.includes(text));
		if (marker !== undefined && marker === this.failOnMarker) {
			throw new Error("server closed the connection");
		}
		const key = marker === undefined ? undefined : MARKERS.find(([text]) => text === marker)?.[1];
		return { rows: (key === undefined ? [] : this.rows[key]) as Row[] };
	};

	public readonly release = (): void => {
		this.released += 1;
	};
}

/**
 * The executor double. `query` on the pool throws on purpose: a snapshot assembled from pool statements would
 * be six statements on six connections with six commit points between them, which is the torn read this
 * adapter exists to prevent.
 */
function harness(rows: FixtureRows = {}) {
	const filled: Required<FixtureRows> = { ...DEFAULT_ROWS, ...rows };
	const sessions: RecordingSession[] = [];
	const executor: SqlExecutor = {
		query: async <Row = Record<string, unknown>>(statement: string): Promise<{ rows: Row[] }> => {
			throw new Error(`snapshot adapter read outside its transaction: ${statement.slice(0, 60)}`);
		},
		transaction: async <Result>(work: (session: SqlClientSession) => Promise<Result>): Promise<Result> => {
			const session = new RecordingSession(filled);
			sessions.push(session);
			await session.query("BEGIN");
			try {
				const result = await work(session);
				await session.query("COMMIT");
				return result;
			} catch (failure) {
				await session.query("ROLLBACK");
				throw failure;
			} finally {
				session.release();
			}
		}
	};
	const repository = new PostgresPermissionSnapshotRepository({ executor });
	const selects = () => sessions[0]?.statements.filter((entry) => entry.statement.includes("SELECT")) ?? [];
	return { executor, repository, sessions, selects };
}

const REQUEST = { guildId: GUILD, userId: USER, channelId: CHANNEL } as const;

describe("PostgresPermissionSnapshotRepository — one transaction, one instant (Contracts, R12)", () => {
	it("issues every statement on one session inside one transaction and releases it once", async () => {
		const { repository, sessions } = harness();

		await repository.loadSnapshot(REQUEST);

		expect(sessions.length).toBe(1);
		const issued = sessions[0]?.statements.map((entry) => entry.statement) ?? [];
		expect(issued[0]).toBe("BEGIN");
		expect(issued.at(-1)).toBe("COMMIT");
		expect(sessions[0]?.released).toBe(1);
	});

	it("pins REPEATABLE READ before the first read, so six statements see one snapshot", async () => {
		const { repository, sessions } = harness();

		await repository.loadSnapshot(REQUEST);

		const issued = sessions[0]?.statements.map((entry) => entry.statement) ?? [];
		expect(issued[1]).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
		// BEGIN, the isolation pin, the six reads, COMMIT: nothing between them takes a fresh snapshot.
		expect(issued.slice(2, 8).every((statement) => statement.includes("SELECT"))).toBe(true);
		expect(issued[8]).toBe("COMMIT");
		expect(issued.filter((statement) => statement.includes("SELECT"))).toHaveLength(6);
	});

	it("binds the Guild id as a parameter on every statement and interpolates no value at all (R1, persistence.md)", async () => {
		const { repository, selects } = harness();

		await repository.loadSnapshot(REQUEST);

		for (const entry of selects()) {
			expect(entry.parameters[0], entry.statement).toBe(GUILD);
			expect(entry.statement).not.toContain(GUILD);
			expect(entry.statement).not.toContain(USER);
			expect(entry.statement).not.toContain(CHANNEL);
			expect(entry.statement).not.toContain(PARENT);
		}
	});

	it("writes nothing (R13)", async () => {
		const { repository, sessions } = harness();

		await repository.loadSnapshot(REQUEST);

		const written = (sessions[0]?.statements ?? []).filter((entry) =>
			/\b(INSERT|UPDATE|DELETE)\b/.test(entry.statement)
		);
		expect(written).toEqual([]);
	});

	it("reads the target and its parent with one channel statement and one overwrite statement", async () => {
		const { repository, selects } = harness();

		await repository.loadSnapshot(REQUEST);

		const channelStatement = selects().find((entry) => entry.statement.includes("FROM channel\n"));
		const overwriteStatement = selects().find((entry) => entry.statement.includes("channel_permission_overwrite"));
		expect(channelStatement?.parameters).toEqual([GUILD, CHANNEL]);
		expect(channelStatement?.statement).toContain("parent_channel_id");
		expect(overwriteStatement?.parameters).toEqual([GUILD, CHANNEL]);
	});

	it("switches to the whole-registry form when no channel is named, in the same one transaction", async () => {
		const { repository, sessions, selects } = harness();

		const snapshot = await repository.loadSnapshot({ guildId: GUILD, userId: USER, channelId: null });

		const channelStatement = selects().find((entry) => entry.statement.includes("FROM channel\n"));
		expect(channelStatement?.parameters).toEqual([GUILD]);
		expect(channelStatement?.statement).not.toContain("$2");
		expect(sessions.length).toBe(1);
		expect(snapshot.channels).toHaveLength(2);
		expect(snapshot.overwriteSets).toHaveLength(2);
	});

	it("projects the rows, folding @everyone apart from the member's own roles (R3, R5)", async () => {
		const { repository } = harness();

		const snapshot = await repository.loadSnapshot(REQUEST);

		expect(snapshot.guild).toEqual({ guildId: GUILD, guildName: "Test guild" });
		expect(snapshot.membership).toEqual({ guildId: GUILD, userId: USER, roleIds: [PARENT] });
		expect(snapshot.everyonePermissions).toBe("1024");
		expect(snapshot.rolePermissions).toEqual([{ roleId: PARENT, permissionsBitfield: "65536" }]);
		expect(snapshot.privateThreadIds).toEqual([CHANNEL]);
		expect(snapshot.channels[0]).toEqual({
			guildId: GUILD,
			channelId: CHANNEL,
			channelType: "public-thread",
			name: "Registry thread",
			position: 1,
			parentChannelId: PARENT
		});
		expect(snapshot.overwriteSets.find((entry) => entry.channelId === CHANNEL)?.overwrites).toEqual([
			{ targetId: GUILD, targetType: "role", allowBitfield: "2048", denyBitfield: "0" }
		]);
		expect(snapshot.overwriteSets.find((entry) => entry.channelId === PARENT)?.overwrites).toEqual([
			{ targetId: USER, targetType: "member", allowBitfield: "0", denyBitfield: "1024" }
		]);
	});

	it("gives every projected channel a set, including the empty one, which is a state and not an unknown (R7)", async () => {
		const { repository } = harness({ overwrites: [] });

		const snapshot = await repository.loadSnapshot(REQUEST);

		expect(snapshot.overwriteSets.map((entry) => entry.overwrites)).toEqual([[], []]);
	});

	it("reports a missing row as null rather than as a zero the derivation would fold (R2, R3, R4)", async () => {
		const { repository } = harness({
			guild: [],
			membership: [],
			roles: [],
			channels: [],
			overwrites: [],
			threadMembers: []
		});

		const snapshot = await repository.loadSnapshot(REQUEST);

		expect(snapshot.guild).toBeNull();
		expect(snapshot.membership).toBeNull();
		expect(snapshot.everyonePermissions).toBeNull();
		expect(snapshot.rolePermissions).toEqual([]);
		expect(snapshot.channels).toEqual([]);
		expect(snapshot.privateThreadIds).toEqual([]);
	});

	it("selects registry channel metadata but no member display data", async () => {
		const { repository, selects } = harness();

		await repository.loadSnapshot(REQUEST);

		for (const entry of selects()) {
			expect(entry.statement).not.toMatch(/nick|username|avatar/i);
		}
	});

	it("rolls back and propagates the failure when a stored bitfield is not Discord's encoding (R3)", async () => {
		const { repository, sessions } = harness({ roles: [{ role_id: GUILD, permissions_bitfield: "1e5" }] });

		await expect(repository.loadSnapshot(REQUEST)).rejects.toThrow(InvalidPermissionBitfieldError);
		expect(sessions[0]?.statements.at(-1)?.statement).toBe("ROLLBACK");
		expect(sessions[0]?.released).toBe(1);
	});

	it("refuses an id that is not a snowflake before it opens a transaction (R9)", async () => {
		const { repository, sessions } = harness();

		await expect(
			repository.loadSnapshot({ guildId: "not-a-snowflake", userId: USER, channelId: CHANNEL })
		).rejects.toThrow(InvalidDiscordIdentifierError);
		expect(sessions).toEqual([]);
	});

	it("propagates a server failure with the transaction rolled back and the session released", async () => {
		const rows = { ...DEFAULT_ROWS };
		const sessions: RecordingSession[] = [];
		const executor: SqlExecutor = {
			query: async () => {
				throw new Error("unreachable");
			},
			transaction: async (work) => {
				const session = new RecordingSession(rows);
				session.failOnMarker = "FROM thread_membership";
				sessions.push(session);
				await session.query("BEGIN");
				try {
					return await work(session);
				} catch (failure) {
					await session.query("ROLLBACK");
					throw failure;
				} finally {
					session.release();
				}
			}
		};
		const repository = new PostgresPermissionSnapshotRepository({ executor });

		await expect(repository.loadSnapshot(REQUEST)).rejects.toThrow(/server closed the connection/);
		expect(sessions[0]?.statements.at(-1)?.statement).toBe("ROLLBACK");
		expect(sessions[0]?.released).toBe(1);
	});
});
