import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../../src/shared/config/app-config.interface.js";
import { APP_CONFIG_TOKEN } from "../../../src/shared/config/config.tokens.js";
import { APP_LOGGER_TOKEN } from "../../../src/shared/logging/logging.tokens.js";
import { PG_POOL_TOKEN } from "../../../src/shared/persistence/persistence.tokens.js";
import type { SqlClientSession, SqlClientSource } from "../../../src/features/guild-state/repositories/sql-executor.js";
import type { DiscordConfig } from "../../../src/features/discord/index.js";
import {
	DISCORD_CONFIG_TOKEN,
	DISCORD_REST_OPERATIONS_TOKEN,
	DISCORD_REQUIRED_INTENTS,
	DiscordModule
} from "../../../src/features/discord/index.js";
import { GuildStateModule } from "../../../src/features/guild-state/guild-state.module.js";
import {
	GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN,
	GUILD_STATE_BOOTSTRAP_STATE_TOKEN,
	GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN,
	GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN,
	GUILD_STATE_CONFIG_TOKEN,
	GUILD_STATE_GATEWAY_TOKEN,
	GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN,
	GUILD_STATE_MEMBERSHIP_END_COMMAND_TOKEN,
	GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN,
	GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN,
	GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
	GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
	GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN,
	GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN,
	GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN,
	GUILD_STATE_RESYNC_COMMAND_TOKEN,
	GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN,
	GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN,
	GUILD_STATE_VANISHED_SWEEP_COMMAND_TOKEN
} from "../../../src/features/guild-state/guild-state.tokens.js";
import type { GuildStateGateway } from "../../../src/features/guild-state/gateways/guild-state-gateway.interface.js";
import { DiscordGuildStateGateway } from "../../../src/features/guild-state/gateways/discord-guild-state.gateway.js";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import type { GuildBootstrapStateTracker } from "../../../src/features/guild-state/models/domain/bootstrap-state.js";
import { GUILD_BOOTSTRAP_PARTS } from "../../../src/features/guild-state/models/domain/bootstrap-state.js";
import { ApplyGuildBootstrapCommand } from "../../../src/features/guild-state/commands/apply-guild-bootstrap.command.js";
import { ApplyMemberUpdateCommand } from "../../../src/features/guild-state/commands/apply-member-update.command.js";
import { ApplyThreadMembershipChangeCommand } from "../../../src/features/guild-state/commands/apply-thread-membership-change.command.js";
import { DeleteChannelCommand } from "../../../src/features/guild-state/commands/delete-channel.command.js";
import { DeleteRoleCommand } from "../../../src/features/guild-state/commands/delete-role.command.js";
import { EndMembershipCommand } from "../../../src/features/guild-state/commands/end-membership.command.js";
import { ResyncGuildStateCommand } from "../../../src/features/guild-state/commands/resync-guild-state.command.js";
import { SweepVanishedStateCommand } from "../../../src/features/guild-state/commands/sweep-vanished-state.command.js";
import { UpsertChannelCommand } from "../../../src/features/guild-state/commands/upsert-channel.command.js";
import { UpsertRoleCommand } from "../../../src/features/guild-state/commands/upsert-role.command.js";
import { EvaluateEffectivePermissionsQuery } from "../../../src/features/guild-state/queries/evaluate-effective-permissions.query.js";
import { GetGuildIdentityQuery } from "../../../src/features/guild-state/queries/get-guild-identity.query.js";
import { GetMembershipStatusQuery } from "../../../src/features/guild-state/queries/get-membership-status.query.js";
import { ListIngestibleChannelsQuery } from "../../../src/features/guild-state/queries/list-ingestible-channels.query.js";
import { ListUserAccessibleChannelsQuery } from "../../../src/features/guild-state/queries/list-user-accessible-channels.query.js";
import type { PermissionSnapshotRepository } from "../../../src/features/guild-state/repositories/permission-snapshot.repository.js";
import { PostgresPermissionSnapshotRepository } from "../../../src/features/guild-state/repositories/postgres-permission-snapshot.repository.js";
import { RecordingLogger } from "./fakes/recording-logger.js";

/**
 * T2's composition, resolved through Nest's own injector rather than asserted by reading the module file
 * (docs/architecture/shared.md: instances resolved by the container, every dependency on an explicit token).
 * This is the only place the two features meet for real: `GuildStateModule` must reach the `discord` feature's
 * exported REST token, build its own gateway contract on top of that adapter, hand the bootstrap command the
 * five repository contracts plus the tracker, and still scope the registry to the Guild the connection serves.
 *
 * A wrong token name, a missing `imports` entry or a factory whose `inject` array is out of order fails here
 * as a resolution error. It is also the runtime half of the claim `guild-state.gateway.test.ts` makes at the
 * type level: that the discord adapter is usable as this feature's gateway.
 *
 * Two seams are replaced, because a composition test must not open a socket or a pool: the Discord REST
 * *transport* (the adapter above it — validation, mapping, retry bound — stays the production one) and the
 * PostgreSQL pool, substituted with a statement recorder. The last case therefore walks a whole bootstrap from
 * wire payload to SQL text, which is the only way to show the wiring carries data end to end.
 */

const GUILD_ID = "160000000000000001";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const CHANNEL_VOICE = "160000000000000204";
const THREAD_PRIVATE = "160000000000000203";

const appConfig: AppConfig = {
	authorization: {
		discordClientId: "fixture",
		discordClientSecret: "fixture",
		publicBaseUrl: "https://hub.example",
		sessionTtlSeconds: 300
	},
	database: { url: "postgresql://user@localhost:5432/app" },
	http: { port: 3_000 },
	logging: { level: "info" }
};

const discordConfig: DiscordConfig = {
	botToken: "fake.bot.token.value",
	guildId: GUILD_ID,
	intents: DISCORD_REQUIRED_INTENTS
};

/** The five reads `GuildStateGateway` names, in the order R2 lists the parts. */
const CONTRACT_READS: (keyof GuildStateGateway)[] = [
	"readGuildSnapshot",
	"readRoles",
	"readChannels",
	"readMemberRoster",
	"readThreadMembers"
];

/** The wire shapes Discord sends; the production mapper and validation read them exactly as given. */
const WIRE_BY_ROUTE: Readonly<Record<string, unknown>> = {
	guild: { id: GUILD_ID, name: "Example Guild HQ", approximate_member_count: 1 },
	roles: [
		{ id: GUILD_ID, name: "@everyone", permissions: "0", position: 0 },
		{ id: ROLE_BACKEND, name: "backend", permissions: "1024", position: 1 }
	],
	channels: [
		{
			id: CHANNEL_PRIVATE,
			type: 0,
			name: "private",
			position: 0,
			permission_overwrites: [{ id: ROLE_BACKEND, type: 0, allow: "1024", deny: "0" }]
		}
	],
	members: [{ user: { id: USER_ONE, username: "someone" }, roles: [ROLE_BACKEND] }],
	"thread-members": []
};

/** The pool seam: records the statements it is handed, opens transactions that always succeed. */
class FakePool implements SqlClientSource {
	public readonly statements: string[] = [];

	/**
	 * Rows to answer a read with, matched on the statement text. Empty by default, which is an empty registry:
	 * the composition tests that must see a stored row — a thread the membership edge can attach to — register
	 * one here instead of the command being handed a pre-built repository.
	 */
	public readRows: { readonly matches: RegExp; readonly rows: Record<string, unknown>[] }[] = [];

	/** The pool lifecycle hook `PgPoolShutdown` calls on close; nothing to end in a recorder. */
	public readonly end = async (): Promise<void> => undefined;

	private readonly answer = (statement: string): Record<string, unknown>[] =>
		this.readRows.find((entry) => entry.matches.test(statement))?.rows ?? [];

	public readonly query = async <Row = Record<string, unknown>>(statement: string): Promise<{ rows: Row[] }> => {
		this.statements.push(statement);
		return { rows: this.answer(statement) as Row[] };
	};

	public readonly connect = async (): Promise<SqlClientSession> => {
		const statements = this.statements;
		const readRows = this.readRows;
		const answerFor = (statement: string): Record<string, unknown>[] =>
			readRows.find((entry) => entry.matches.test(statement))?.rows ?? [];
		return {
			query: async <Row = Record<string, unknown>>(statement: string) => {
				statements.push(statement);
				return { rows: answerFor(statement) as Row[] };
			},
			release: () => undefined
		};
	};
}

/** The wire shapes Discord sends, keyed by the REST path the production adapter builds. */
function wireForPath(path: string): unknown {
	if (path === `/guilds/${GUILD_ID}`) {
		return WIRE_BY_ROUTE["guild"];
	}
	if (path === `/guilds/${GUILD_ID}/roles`) {
		return WIRE_BY_ROUTE["roles"];
	}
	if (path === `/guilds/${GUILD_ID}/channels`) {
		return WIRE_BY_ROUTE["channels"];
	}
	if (path === `/guilds/${GUILD_ID}/members`) {
		return WIRE_BY_ROUTE["members"];
	}
	if (path.endsWith("/thread-members")) {
		return WIRE_BY_ROUTE["thread-members"];
	}
	// Nothing else is reachable from this feature: an unexpected path is a test bug, not a silent empty answer.
	throw new Error(`composed fixture received an unexpected REST path ${path}`);
}

/** The transport seam: answers by path, so the adapter's own paths, bounds and validation are exercised. */
const transport = {
	get: async (request: { readonly path: string }) => ({ status: 200, payload: wireForPath(request.path) })
};

async function compose() {
	const logger = new RecordingLogger();
	const pool = new FakePool();
	// One `DiscordModule` instance shared by both sides, the way the composition root shares one adapter.
	const discord = DiscordModule.forRoot({
		config: discordConfig,
		restTransport: transport as never,
		clientFactory: {} as never,
		logger,
		clock: () => new Date("2026-11-05T00:00:00.000Z"),
		wait: async () => undefined
	});

	const moduleRef = await Test.createTestingModule({
		imports: [
			discord,
			GuildStateModule.forRoot({
				imports: [discord],
				bootstrap: { rosterMaxPages: 5, writeBatchSize: 50 },
				logger
			})
		]
	})
		.overrideProvider(APP_CONFIG_TOKEN)
		.useValue(appConfig)
		.overrideProvider(APP_LOGGER_TOKEN)
		.useValue(logger)
		.overrideProvider(PG_POOL_TOKEN)
		.useValue(pool)
		.compile();

	return { moduleRef, logger, pool };
}

describe("guild-state module composition (T2)", () => {
	it("resolves the gateway, the tracker and the bootstrap command behind their own tokens", async () => {
		const { moduleRef } = await compose();

		const gateway = moduleRef.get<GuildStateGateway>(GUILD_STATE_GATEWAY_TOKEN);
		const tracker = moduleRef.get<GuildBootstrapStateTracker>(GUILD_STATE_BOOTSTRAP_STATE_TOKEN);
		const command = moduleRef.get<ApplyGuildBootstrapCommand>(GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN);

		for (const read of CONTRACT_READS) {
			expect(typeof gateway[read]).toBe("function");
		}
		expect(gateway).toBeInstanceOf(DiscordGuildStateGateway);
		expect(command).toBeInstanceOf(ApplyGuildBootstrapCommand);
		expect(tracker).toBeInstanceOf(InMemoryBootstrapStateTracker);

		// A fresh process starts with every part pending: nothing is claimed complete before a pass runs.
		expect(tracker.isComplete()).toBe(false);
		expect(tracker.pendingParts()).toEqual([...GUILD_BOOTSTRAP_PARTS]);
		expect(tracker.guildId).toBe(GUILD_ID);

		await moduleRef.close();
	});

	it("takes the configured Guild from the discord feature, so one Installation has one registry scope (R1)", async () => {
		const { moduleRef } = await compose();

		const discord = moduleRef.get<DiscordConfig>(DISCORD_CONFIG_TOKEN);
		const config = moduleRef.get<{
			guildId: string;
			bootstrap: { rosterMaxPages: number; writeBatchSize: number };
		}>(GUILD_STATE_CONFIG_TOKEN);

		expect(config.guildId).toBe(discord.guildId);
		// The bounds a composition declares are the ones the command reads; nothing is silently re-defaulted.
		expect(config.bootstrap).toEqual({ rosterMaxPages: 5, writeBatchSize: 50 });

		await moduleRef.close();
	});

	it("builds the gateway on the discord REST token instead of a second adapter (Contracts)", async () => {
		const { moduleRef } = await compose();

		const rest = moduleRef.get<{ readGuildSnapshot: unknown }>(DISCORD_REST_OPERATIONS_TOKEN);
		const gateway = moduleRef.get<GuildStateGateway>(GUILD_STATE_GATEWAY_TOKEN);

		expect(typeof rest.readGuildSnapshot).toBe("function");
		// The gateway is a delegate: its own state is the operations it was handed, and nothing else — no queue,
		// no retry budget, no page cursor of its own (docs/features/discord.md R7 owns all of those).
		const ownKeys = Object.keys(gateway);
		expect(ownKeys.filter((key) => typeof gateway[key as keyof GuildStateGateway] !== "function")).toEqual([
			"deps"
		]);
		expect(ownKeys.filter((key) => typeof gateway[key as keyof GuildStateGateway] === "function").sort()).toEqual(
			[...CONTRACT_READS].sort()
		);

		await moduleRef.close();
	});

	it("walks one bootstrap from a Discord wire payload down to registry SQL (R2 end to end)", async () => {
		const { moduleRef, pool, logger } = await compose();
		const command = moduleRef.get<ApplyGuildBootstrapCommand>(GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN);

		const report = await command.execute();

		expect(report.guildId).toBe(GUILD_ID);
		expect(report.parts.map((part) => part.part)).toEqual([
			"guild",
			"roles",
			"channels",
			"roster",
			"thread-members"
		]);
		expect(report.complete).toBe(true);
		expect(report.gaps).toEqual([]);

		const sql = pool.statements.join("\n");
		expect(sql).toContain("INSERT INTO guild (guild_id, guild_name)");
		expect(sql).toContain("INSERT INTO guild_role");
		expect(sql).toContain("INSERT INTO channel");
		expect(sql).toContain("INSERT INTO channel_permission_overwrite");
		expect(sql).toContain("INSERT INTO guild_membership");
		// Every write is a bound statement: no payload value is ever interpolated into SQL text (persistence.md).
		expect(sql).not.toContain("Example Guild HQ");
		expect(sql).not.toContain("backend");
		expect(logger.transcript()).toContain(GUILD_ID);

		await moduleRef.close();
	});

	it("reports the same pass as complete through the composed tracker, the state the rows are backed by (R2, R9)", async () => {
		const { moduleRef } = await compose();
		const command = moduleRef.get<ApplyGuildBootstrapCommand>(GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN);
		const tracker = moduleRef.get<GuildBootstrapStateTracker>(GUILD_STATE_BOOTSTRAP_STATE_TOKEN);

		expect(tracker.isComplete()).toBe(false);
		await command.execute();

		// The tracker the composition injected is the one the command wrote to: one instance, one answer.
		expect(tracker.isComplete()).toBe(true);
		expect(tracker.pendingParts()).toEqual([]);

		await moduleRef.close();
	});
});

describe("guild-state module composition — event application (T3, T4)", () => {
	it("resolves the four event-application commands behind their own explicit tokens", async () => {
		const { moduleRef } = await compose();

		const upsertRole = moduleRef.get<UpsertRoleCommand>(GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN);
		const deleteRole = moduleRef.get<DeleteRoleCommand>(GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN);
		const applyMember = moduleRef.get<ApplyMemberUpdateCommand>(GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN);
		const endMembership = moduleRef.get<EndMembershipCommand>(GUILD_STATE_MEMBERSHIP_END_COMMAND_TOKEN);

		expect(upsertRole).toBeInstanceOf(UpsertRoleCommand);
		expect(deleteRole).toBeInstanceOf(DeleteRoleCommand);
		expect(applyMember).toBeInstanceOf(ApplyMemberUpdateCommand);
		expect(endMembership).toBeInstanceOf(EndMembershipCommand);

		await moduleRef.close();
	});

	it("resolves the resync sweep and the status query behind their own explicit tokens (T8, T10)", async () => {
		const { moduleRef } = await compose();

		const resync = moduleRef.get<ResyncGuildStateCommand>(GUILD_STATE_RESYNC_COMMAND_TOKEN);
		const sweep = moduleRef.get<SweepVanishedStateCommand>(GUILD_STATE_VANISHED_SWEEP_COMMAND_TOKEN);

		expect(resync).toBeInstanceOf(ResyncGuildStateCommand);
		expect(sweep).toBeInstanceOf(SweepVanishedStateCommand);

		await moduleRef.close();
	});

	it("runs a role event and a member event from the composed tokens down to registry SQL (R3, R4, R5)", async () => {
		const { moduleRef, pool } = await compose();
		const upsertRole = moduleRef.get<UpsertRoleCommand>(GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN);
		const applyMember = moduleRef.get<ApplyMemberUpdateCommand>(GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN);
		const deleteRole = moduleRef.get<DeleteRoleCommand>(GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN);
		const endMembership = moduleRef.get<EndMembershipCommand>(GUILD_STATE_MEMBERSHIP_END_COMMAND_TOKEN);

		await upsertRole.execute({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: "backend",
			permissionsBitfield: "1024",
			position: 1
		});
		await applyMember.execute({ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] });
		await deleteRole.execute({ guildId: GUILD_ID, roleId: ROLE_BACKEND });
		await endMembership.execute({ guildId: GUILD_ID, userId: USER_ONE });

		const sql = pool.statements.join("\n");
		expect(sql).toContain("INSERT INTO guild_role");
		expect(sql).toContain("INSERT INTO guild_membership (guild_id, user_id)");
		expect(sql).toContain("DELETE FROM guild_membership_role");
		expect(sql).toContain("DELETE FROM channel_permission_overwrite");
		expect(sql).toContain("DELETE FROM guild_membership");
		// Values reach PostgreSQL as parameters only — the payload text is never inside a statement (persistence.md).
		expect(sql).not.toContain("backend");
		expect(sql).not.toContain("1024");

		await moduleRef.close();
	});

	it("scopes every composed event to the Guild the connection serves, and drops the rest (R1)", async () => {
		const { moduleRef, pool, logger } = await compose();
		const upsertRole = moduleRef.get<UpsertRoleCommand>(GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN);
		const applyMember = moduleRef.get<ApplyMemberUpdateCommand>(GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN);

		const FOREIGN_GUILD_ID = "160000000000000999";
		await upsertRole.execute({
			guildId: FOREIGN_GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: "foreign",
			permissionsBitfield: "1024",
			position: 1
		});
		await applyMember.execute({ guildId: FOREIGN_GUILD_ID, userId: USER_ONE, roleIds: [] });

		// Not one statement left the feature: a foreign event is dropped, not stored (R1).
		expect(pool.statements).toEqual([]);
		expect(logger.transcript()).toContain(FOREIGN_GUILD_ID);
		expect(logger.transcript()).not.toContain("foreign");

		await moduleRef.close();
	});
});

describe("guild-state module composition — channel, thread and thread-member events (T5, T6)", () => {
	it("resolves the channel/thread and thread-membership commands behind their own explicit tokens", async () => {
		const { moduleRef } = await compose();

		const upsertChannel = moduleRef.get<UpsertChannelCommand>(GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN);
		const deleteChannel = moduleRef.get<DeleteChannelCommand>(GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN);
		const threadMember = moduleRef.get<ApplyThreadMembershipChangeCommand>(
			GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN
		);

		expect(upsertChannel).toBeInstanceOf(UpsertChannelCommand);
		expect(deleteChannel).toBeInstanceOf(DeleteChannelCommand);
		expect(threadMember).toBeInstanceOf(ApplyThreadMembershipChangeCommand);

		await moduleRef.close();
	});

	it("runs a channel event and a channel deletion from the tokens down to registry SQL (R6, R7)", async () => {
		const { moduleRef, pool } = await compose();
		const upsertChannel = moduleRef.get<UpsertChannelCommand>(GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN);
		const deleteChannel = moduleRef.get<DeleteChannelCommand>(GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN);

		await upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private",
			position: 0,
			permissionOverwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: "1024", denyBitfield: "0" }
			]
		});
		await deleteChannel.execute({ guildId: GUILD_ID, channelId: CHANNEL_PRIVATE });

		const sql = pool.statements.join("\n");
		expect(sql).toContain("INSERT INTO channel ");
		expect(sql).toContain("INSERT INTO channel_permission_overwrite");
		expect(sql).toContain("DELETE FROM channel_permission_overwrite");
		expect(sql).toContain("DELETE FROM thread_membership");
		// The named channel itself, by its own key — the cascade's last statement, after the children it removed.
		expect(sql).toMatch(/DELETE FROM channel\s+WHERE guild_id = \$1 AND channel_id = \$2/);
		// Values reach PostgreSQL as parameters only — the payload text is never inside a statement.
		expect(sql).not.toContain("private");
		expect(sql).not.toContain("1024");

		await moduleRef.close();
	});

	it("writes and removes one thread-membership edge from the composed token down to registry SQL (R8, R9)", async () => {
		const { moduleRef, pool } = await compose();
		// The registry holds the thread the edge names. The read the composed channel repository issues is what
		// the command consults before it may write, so the row comes back through the pool — never from a
		// repository the test built by hand.
		pool.readRows = [
			{
				matches: /FROM channel\s+WHERE guild_id = \$1 AND channel_id = \$2/,
				rows: [
					{
						channel_id: THREAD_PRIVATE,
						guild_id: GUILD_ID,
						channel_type: "private-thread",
						channel_name: null,
						channel_position: null,
						is_thread: true,
						parent_channel_id: CHANNEL_PRIVATE
					}
				]
			}
		];
		const threadMember = moduleRef.get<ApplyThreadMembershipChangeCommand>(
			GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN
		);

		expect(
			await threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_PRIVATE,
				userId: USER_ONE,
				change: "added"
			})
		).toMatchObject({ status: "applied", change: "added" });
		expect(
			await threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_PRIVATE,
				userId: USER_ONE,
				change: "removed"
			})
		).toMatchObject({ status: "applied", change: "removed" });

		const sql = pool.statements.join("\n");
		expect(sql).toContain("INSERT INTO thread_membership");
		expect(sql).toContain("DELETE FROM thread_membership");
		expect(sql).not.toContain(USER_ONE);

		await moduleRef.close();
	});

	it("drops a channel event, a deletion and a thread-member change that name another Guild (R1)", async () => {
		const { moduleRef, pool, logger } = await compose();
		const upsertChannel = moduleRef.get<UpsertChannelCommand>(GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN);
		const deleteChannel = moduleRef.get<DeleteChannelCommand>(GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN);
		const threadMember = moduleRef.get<ApplyThreadMembershipChangeCommand>(
			GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN
		);
		const FOREIGN_GUILD_ID = "160000000000000999";

		expect(
			await upsertChannel.execute({
				guildId: FOREIGN_GUILD_ID,
				channelId: CHANNEL_PRIVATE,
				channelType: "guild-text",
				name: "foreign",
				permissionOverwrites: []
			})
		).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(await deleteChannel.execute({ guildId: FOREIGN_GUILD_ID, channelId: CHANNEL_PRIVATE })).toMatchObject({
			status: "dropped",
			reason: "foreign-guild"
		});
		expect(
			await threadMember.execute({
				guildId: FOREIGN_GUILD_ID,
				threadId: THREAD_PRIVATE,
				userId: USER_ONE,
				change: "added"
			})
		).toMatchObject({ status: "dropped", reason: "foreign-guild" });

		expect(pool.statements).toEqual([]);
		expect(logger.transcript()).toContain(FOREIGN_GUILD_ID);
		expect(logger.transcript()).not.toContain("foreign");

		await moduleRef.close();
	});

	it("refuses a channel event whose parent the registry does not hold, and a membership change for an unknown thread (R6, R8)", async () => {
		const { moduleRef, pool } = await compose();
		const upsertChannel = moduleRef.get<UpsertChannelCommand>(GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN);
		const threadMember = moduleRef.get<ApplyThreadMembershipChangeCommand>(
			GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN
		);

		// The composed executor answers every read with no rows, which is an empty registry seen through the
		// production adapters: both commands must reach their returned refusal instead of writing.
		expect(
			await upsertChannel.execute({
				guildId: GUILD_ID,
				channelId: THREAD_PRIVATE,
				channelType: "private-thread",
				parentChannelId: CHANNEL_PRIVATE
			})
		).toMatchObject({ status: "refused", reason: "parent-not-registered" });
		expect(
			await threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_PRIVATE,
				userId: USER_ONE,
				change: "added"
			})
		).toMatchObject({ status: "refused", reason: "unknown-thread" });

		expect(
			pool.statements.filter((statement) => /INSERT INTO channel |INSERT INTO thread_membership/.test(statement))
		).toEqual([]);

		await moduleRef.close();
	});
});

describe("guild-state module composition — evaluation and registry queries (T7)", () => {
	it("resolves the evaluation and the four companion reads behind their own explicit tokens", async () => {
		const { moduleRef } = await compose();

		expect(
			moduleRef.get<EvaluateEffectivePermissionsQuery>(GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN)
		).toBeInstanceOf(EvaluateEffectivePermissionsQuery);
		expect(moduleRef.get<GetGuildIdentityQuery>(GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN)).toBeInstanceOf(
			GetGuildIdentityQuery
		);
		expect(moduleRef.get<GetMembershipStatusQuery>(GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN)).toBeInstanceOf(
			GetMembershipStatusQuery
		);
		expect(
			moduleRef.get<ListUserAccessibleChannelsQuery>(GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN)
		).toBeInstanceOf(ListUserAccessibleChannelsQuery);
		expect(moduleRef.get<ListIngestibleChannelsQuery>(GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN)).toBeInstanceOf(
			ListIngestibleChannelsQuery
		);
		expect(moduleRef.get<PermissionSnapshotRepository>(GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN)).toBeInstanceOf(
			PostgresPermissionSnapshotRepository
		);

		await moduleRef.close();
	});

	it("decides one channel from composed tokens down to real SQL parameters (R12, R13, R1)", async () => {
		const { moduleRef, pool } = await compose();
		pool.readRows = [
			{ matches: /FROM guild\n/, rows: [{ guild_id: GUILD_ID, guild_name: "Test guild" }] },
			{
				matches: /FROM guild_membership AS m/,
				rows: [{ guild_id: GUILD_ID, user_id: USER_ONE, role_ids: [ROLE_BACKEND] }]
			},
			{
				matches: /FROM guild_role AS role/,
				rows: [
					{ role_id: GUILD_ID, permissions_bitfield: "1024" },
					{ role_id: ROLE_BACKEND, permissions_bitfield: "65536" }
				]
			},
			{
				matches: /FROM channel_permission_overwrite/,
				rows: [
					{
						channel_id: CHANNEL_PUBLIC,
						overwrite_target_id: ROLE_BACKEND,
						overwrite_target_type: "role",
						allow_bitfield: "2048",
						deny_bitfield: "0"
					}
				]
			},
			{
				matches: /FROM channel\n/,
				rows: [
					{
						channel_id: CHANNEL_PUBLIC,
						guild_id: GUILD_ID,
						channel_type: "guild-text",
						channel_position: 0,
						parent_channel_id: null
					}
				]
			},
			{ matches: /FROM thread_membership/, rows: [] }
		];

		const decided = await moduleRef
			.get<EvaluateEffectivePermissionsQuery>(GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN)
			.execute({ userId: USER_ONE, channelId: CHANNEL_PUBLIC });

		expect(decided.status).toBe("evaluated");
		expect(decided.permissions.bitfield).toBe("68608"); // 1024 view | 2048 send (role stage allow) | 65536 history (role bit)
		expect(decided.permissions.has("send-messages")).toBe(true);

		const sql = pool.statements.join("\n");
		expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
		expect(pool.statements.filter((statement) => /^\s*SELECT/.test(statement))).toHaveLength(6);
		expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
		expect(pool.statements.some((statement) => statement.includes(`'${USER_ONE}'`))).toBe(false);

		await moduleRef.close();
	});

	it("lists accessible channels through the composed token with one wide read, and refuses a foreign guild id (Contracts, R1)", async () => {
		const { moduleRef, pool, logger } = await compose();
		pool.readRows = [
			{ matches: /FROM guild\n/, rows: [{ guild_id: GUILD_ID, guild_name: "Test guild" }] },
			{ matches: /FROM guild_membership AS m/, rows: [{ guild_id: GUILD_ID, user_id: USER_ONE, role_ids: [] }] },
			{ matches: /FROM guild_role AS role/, rows: [{ role_id: GUILD_ID, permissions_bitfield: "1024" }] },
			{
				matches: /FROM channel_permission_overwrite/,
				rows: [
					{
						channel_id: CHANNEL_VOICE,
						overwrite_target_id: GUILD_ID,
						overwrite_target_type: "role",
						allow_bitfield: "0",
						deny_bitfield: "1024"
					}
				]
			},
			{
				matches: /FROM channel\n/,
				rows: [
					{
						channel_id: CHANNEL_PUBLIC,
						guild_id: GUILD_ID,
						channel_type: "guild-text",
						channel_position: 0,
						parent_channel_id: null
					},
					{
						channel_id: CHANNEL_VOICE,
						guild_id: GUILD_ID,
						channel_type: "guild-voice",
						channel_position: 1,
						parent_channel_id: null
					}
				]
			},
			{ matches: /FROM thread_membership/, rows: [] }
		];

		const listed = await moduleRef
			.get<ListUserAccessibleChannelsQuery>(GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN)
			.execute({ userId: USER_ONE });

		expect(listed.channels.map((entry) => entry.channelId)).toEqual([CHANNEL_PUBLIC]);
		expect(listed.evaluatedChannelCount).toBe(2);
		// One pass, wide form: the channel statement carries no channel parameter to narrow it.
		expect(pool.statements.filter((statement) => /^\s*SELECT/.test(statement))).toHaveLength(6);

		const identity = await moduleRef.get<GetGuildIdentityQuery>(GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN).execute();
		expect(identity).toEqual({ status: "registered", guild: { guildId: GUILD_ID, guildName: "Test guild" } });

		const status = await moduleRef
			.get<GetMembershipStatusQuery>(GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN)
			.execute({ userId: USER_ONE });
		expect(status.status).toBe("present");

		expect(logger.transcript()).not.toContain("1024");
		await moduleRef.close();
	});
});
