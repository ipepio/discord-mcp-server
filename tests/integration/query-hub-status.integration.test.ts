import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QueryToolsAdapter } from "../../src/features/query/mcp/query-tools.adapter.js";
import type { QueryToolHandlers } from "../../src/features/query/mcp/query-tools.adapter.js";
import { QueryAccessPolicy } from "../../src/features/query/queries/query-access.policy.js";
import type {
	RegistryAccessReader,
	RegistryStatusReader
} from "../../src/features/query/queries/query-access.policy.js";
import { ListChannelsQuery } from "../../src/features/query/queries/list-channels.query.js";
import type { BotViewableChannelsReader } from "../../src/features/query/queries/bot-access.js";
import { GetHubStatusQuery } from "../../src/features/query/queries/get-hub-status.query.js";
import { createGuildStateConfig } from "../../src/features/guild-state/config/guild-state-config.interface.js";
import { PostgresGuildRegistryRepository } from "../../src/features/guild-state/repositories/postgres-guild-registry.repository.js";
import { PostgresRoleRegistryRepository } from "../../src/features/guild-state/repositories/postgres-role-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-membership-registry.repository.js";
import { PostgresChannelRegistryRepository } from "../../src/features/guild-state/repositories/postgres-channel-registry.repository.js";
import { PostgresPermissionSnapshotRepository } from "../../src/features/guild-state/repositories/postgres-permission-snapshot.repository.js";
import { ListUserAccessibleChannelsQuery } from "../../src/features/guild-state/queries/list-user-accessible-channels.query.js";
import { ListIngestibleChannelsQuery } from "../../src/features/guild-state/queries/list-ingestible-channels.query.js";
import { GetGuildIdentityQuery } from "../../src/features/guild-state/index.js";
import type { GuildRegistryStatus } from "../../src/features/guild-state/index.js";
import type { RegistryChannel, RegistryRole } from "../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "../features/guild-state/fakes/recording-logger.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";

/**
 * R17 evidence — `get_hub_status` answers "is this hub healthy, and is this count the truth?" in one call
 * (docs/features/query.md R17, owner decision "3 · Tool de estado"). The failure it exists for: a client
 * compared today's short `list_channels` page with an older, longer one and reported a pagination defect
 * (`odd/tasks/mcp-client-resilience.md` L1, S3/S4).
 *
 * Both axes are the real guild-state contracts over real registry rows in an isolated PostgreSQL database,
 * exactly as `list-channels-ingestible-only` composes them: `ListUserAccessibleChannelsQuery` for the
 * Requester, `ListIngestibleChannelsQuery` for the bot and `GetGuildIdentityQuery` for the identity. The
 * count is asserted against what paging the real `list_channels` actually returns, which is the whole point
 * of the tool: it may state nothing the caller could not enumerate (R3).
 *
 * The registry status is a double with a switch, because the four statuses are guild-state's derivation and
 * its own suite proves them; here they are the input this tool must report instead of refusing (R11).
 */

const GUILD_ID = "190000000000000001";
const REQUESTER_ID = "190000000000000101";
const BOT_USER_ID = "190000000000000109";
const GUILD_NAME = "Hub status guild";

const VIEW = "1024";
const HISTORY = "65536";

const CHANNEL_ALPHA = "190000000000000201";
const CHANNEL_ZETA = "190000000000000299";
/** The Requester can view it; the bot cannot. */
const CHANNEL_BETA = "190000000000000202";
/** The bot can view it; the Requester cannot. */
const CHANNEL_GAMMA = "190000000000000203";
/** Non-text-capable rows: never mirrored, so never counted. */
const CHANNEL_VOICE = "190000000000000205";
const CHANNEL_CATEGORY = "190000000000000206";
const MESSAGE_ALPHA = "190000000000000301";

const identity = { userId: REQUESTER_ID, sessionId: "guard-resolved", expiresAt: new Date("2099-01-01") };

describe.skipIf(!HAS_TEST_DATABASE)("hub status (R17, real PostgreSQL registry)", () => {
	let database: IsolatedTestDatabase;
	let guilds: PostgresGuildRegistryRepository;
	let roles: PostgresRoleRegistryRepository;
	let members: PostgresMembershipRegistryRepository;
	let channels: PostgresChannelRegistryRepository;
	let listForUser: ListUserAccessibleChannelsQuery;
	let listIngestible: ListIngestibleChannelsQuery;
	let guildIdentity: GetGuildIdentityQuery;
	/** The status the reader reports; `throw` is the unreadable-status case. */
	let registryStatus: GuildRegistryStatus | "throw";
	let registryFails: boolean;
	let botFails: boolean;
	let requesterReads: number;
	let botReads: number;
	let adapter: QueryToolsAdapter;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("query_hub_status");
		const logger = new RecordingLogger();
		const config = createGuildStateConfig({ guildId: GUILD_ID });
		guilds = new PostgresGuildRegistryRepository({ executor: database.executor });
		roles = new PostgresRoleRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		members = new PostgresMembershipRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		channels = new PostgresChannelRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		const snapshots = new PostgresPermissionSnapshotRepository({ executor: database.executor });
		listForUser = new ListUserAccessibleChannelsQuery({ config, snapshot: snapshots, logger });
		listIngestible = new ListIngestibleChannelsQuery({ config, snapshot: snapshots, logger });
		guildIdentity = new GetGuildIdentityQuery({ config, guildRegistry: guilds, logger });
	}, 180_000);

	afterAll(async () => {
		await database?.close();
		database = undefined as unknown as IsolatedTestDatabase;
	});

	const role = (roleId: string, bitfield: string, position = 1): RegistryRole => ({
		guildId: GUILD_ID,
		roleId,
		roleName: `role-${roleId.slice(-3)}`,
		permissionsBitfield: bitfield,
		position
	});

	const channel = (
		channelId: string,
		channelType: RegistryChannel["channelType"],
		position: number
	): RegistryChannel => ({
		guildId: GUILD_ID,
		channelId,
		channelType,
		name: `channel-${channelId.slice(-3)}`,
		position,
		parentChannelId: null
	});

	/**
	 * `zeroFor` empties one side of the intersection without touching the other: an absent Requester
	 * Membership fails closed on the visibility axis, and a bot-side `VIEW_CHANNEL` denial empties the
	 * ingestible axis. Both must answer `0`, indistinguishably (R3, R17's "honest zero").
	 */
	async function applyRegistry(zeroFor: "none" | "requester" | "bot" = "none") {
		await database.resetRegistry();
		await database.resetMessageStore();
		await guilds.upsertGuild({ guildId: GUILD_ID, guildName: GUILD_NAME });
		await roles.upsertRoles([role(GUILD_ID, (BigInt(VIEW) | BigInt(HISTORY)).toString())]);
		await members.upsertMemberships([
			{ guildId: GUILD_ID, userId: REQUESTER_ID, roleIds: [] },
			{ guildId: GUILD_ID, userId: BOT_USER_ID, roleIds: [] }
		]);
		await channels.upsertChannels([
			channel(CHANNEL_CATEGORY, "guild-category", 0),
			channel(CHANNEL_ALPHA, "guild-text", 1),
			channel(CHANNEL_ZETA, "guild-text", 1),
			channel(CHANNEL_BETA, "guild-text", 2),
			channel(CHANNEL_GAMMA, "guild-text", 3),
			channel(CHANNEL_VOICE, "guild-voice", 5)
		]);
		// The bot mirrors neither #beta (denied here) nor #gamma (denied to the Requester below).
		for (const channelId of zeroFor === "bot" ? [CHANNEL_BETA, CHANNEL_ALPHA, CHANNEL_ZETA] : [CHANNEL_BETA])
			await channels.replaceChannelOverwrites({
				guildId: GUILD_ID,
				channelId,
				overwrites: [{ targetId: BOT_USER_ID, targetType: "member", allowBitfield: "0", denyBitfield: VIEW }]
			});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_GAMMA,
			overwrites: [{ targetId: REQUESTER_ID, targetType: "member", allowBitfield: "0", denyBitfield: VIEW }]
		});
		if (zeroFor === "requester") await members.deleteMembershipAndDependents(GUILD_ID, REQUESTER_ID);
		await database.pool.query(
			`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant)
			 VALUES ($1,$2,$3,$4,'default','mirrored body','2026-01-01')`,
			[MESSAGE_ALPHA, GUILD_ID, CHANNEL_ALPHA, REQUESTER_ID]
		);
		registryStatus = "current";
		registryFails = false;
		botFails = false;
		requesterReads = 0;
		botReads = 0;
		adapter = new QueryToolsAdapter(buildHandlers());
	}

	const statusReader: RegistryStatusReader = {
		execute: async () => {
			if (registryStatus === "throw") throw new Error("status read failed");
			return { guildId: GUILD_ID, status: registryStatus };
		}
	};

	/** The Requester axis: the real contract, counted so the sweep can prove a non-current status reads nothing. */
	const registry: RegistryAccessReader = {
		execute: async (input) => {
			requesterReads += 1;
			if (registryFails) throw new Error("requester axis failed");
			const listed = await listForUser.execute(input);
			return {
				guildId: listed.guildId,
				channels: listed.channels.map((entry) => ({
					...entry,
					name: entry.name ?? "",
					position: entry.position ?? 0
				}))
			};
		}
	};

	/** The bot axis: the same ingestible contract ingestion enumerates from, counted the same way. */
	const bot: BotViewableChannelsReader = {
		execute: async (input) => {
			botReads += 1;
			if (botFails) throw new Error("bot axis failed");
			const listed = await listIngestible.execute(input);
			return {
				channels: listed.channels,
				botCannotViewChannelIds: listed.botCannotViewChannelIds,
				botMembershipRegistered: listed.botMembershipRegistered
			};
		}
	};

	/** Composition as `QueryModule` wires it; only the two tools this suite talks to are real. */
	function buildHandlers(): QueryToolHandlers {
		const access = new QueryAccessPolicy(statusReader, registry);
		const unused = { execute: async () => ({ data: [] }) };
		return {
			get_hub_status: new GetHubStatusQuery(statusReader, guildIdentity, access, bot, BOT_USER_ID),
			list_channels: new ListChannelsQuery(access, bot, BOT_USER_ID),
			search_messages: unused,
			get_channel_history: unused,
			get_thread_messages: unused,
			get_message_context: unused,
			get_recent_activity: unused
		};
	}

	function call(name: "get_hub_status" | "list_channels", args: Record<string, unknown> = {}) {
		return adapter.handle(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
			identity
		);
	}

	interface ToolCallAnswer {
		readonly result: {
			readonly isError: boolean;
			readonly structuredContent: Record<string, unknown>;
		};
	}

	async function hubStatus(args: Record<string, unknown> = {}): Promise<ToolCallAnswer> {
		return (await call("get_hub_status", args)) as ToolCallAnswer;
	}

	function content(answer: ToolCallAnswer): Record<string, unknown> {
		return answer.result.structuredContent;
	}

	/** Page `list_channels` to exhaustion: the enumeration the count must not exceed. */
	async function listAllChannelIds(): Promise<readonly string[]> {
		const listed: string[] = [];
		let cursor: string | null = null;
		do {
			const answer = (await call("list_channels", { pageSize: 1, ...(cursor ? { cursor } : {}) })) as {
				result: {
					structuredContent: {
						data: { channelId: string }[];
						pagination: { hasNext: boolean; nextCursor: string | null };
					};
				};
			};
			listed.push(...answer.result.structuredContent.data.map((entry) => entry.channelId));
			cursor = answer.result.structuredContent.pagination.hasNext
				? answer.result.structuredContent.pagination.nextCursor
				: null;
		} while (cursor !== null);
		return listed;
	}

	beforeEach(async () => {
		await applyRegistry();
	});

	it("hub-status-reports-mirror-scope", async () => {
		const answer = await hubStatus();
		expect(answer.result.isError).toBe(false);
		expect(content(answer)).toEqual({
			guild: { name: GUILD_NAME, id: GUILD_ID },
			registry: { status: "current" },
			mirror: { visibleAndMirroredChannelCount: 2 }
		});
		// The count is exactly what paging list_channels returns: #alpha and #zeta are readable by both, while
		// #beta (bot denied) and #gamma (Requester denied) are outside the intersection (R12).
		const enumerated = await listAllChannelIds();
		expect(enumerated).toEqual([CHANNEL_ALPHA, CHANNEL_ZETA]);
		expect(content(answer)["mirror"]).toEqual({ visibleAndMirroredChannelCount: enumerated.length });
		// The whole result is the status object: no data array and no pagination (R17's fourth envelope).
		expect(content(answer)).not.toHaveProperty("data");
		expect(content(answer)).not.toHaveProperty("pagination");
	});

	it("hub-status-never-leaks-identities", async () => {
		const serialized = JSON.stringify(content(await hubStatus()));
		for (const hidden of [
			CHANNEL_ALPHA,
			CHANNEL_ZETA,
			CHANNEL_BETA,
			CHANNEL_GAMMA,
			CHANNEL_VOICE,
			CHANNEL_CATEGORY,
			"channel-201",
			"channel-299",
			"channel-202",
			"channel-203",
			MESSAGE_ALPHA,
			"mirrored body"
		])
			expect(serialized).not.toContain(hidden);
		// No per-container field at all, so it cannot confirm the existence of a container list_channels omits.
		expect(Object.keys(content(await hubStatus())).sort()).toEqual(["guild", "mirror", "registry"]);
		// The only numbers in the payload are the Guild id R17 requires and the enumerable count: nothing
		// counts the containers the caller cannot enumerate (R3).
		expect(serialized.match(/\d+/g)).toEqual([GUILD_ID, "2"]);
	});

	it("answers the honest zero for an empty intersection, without saying which axis emptied it", async () => {
		const visibleBoth = content(await hubStatus());

		await applyRegistry("requester");
		const requesterSeesNothing = await hubStatus();
		expect(content(requesterSeesNothing)["mirror"]).toEqual({ visibleAndMirroredChannelCount: 0 });
		expect((await listAllChannelIds()).length).toBe(0);

		await applyRegistry("bot");
		const botMirrorsNothing = await hubStatus();
		expect(content(botMirrorsNothing)["mirror"]).toEqual({ visibleAndMirroredChannelCount: 0 });
		expect((await listAllChannelIds()).length).toBe(0);

		// R3: the two zeros are the same payload, and both differ from the healthy count only in the number.
		expect(requesterSeesNothing).toEqual(botMirrorsNothing);
		expect(visibleBoth["mirror"]).toEqual({ visibleAndMirroredChannelCount: 2 });
	});

	it.each(["stale", "incomplete", "unavailable"] as const)(
		"%s registry reports the status and a null count instead of state_unavailable",
		async (value) => {
			registryStatus = value;
			const answer = await hubStatus();
			expect(answer.result.isError).toBe(false);
			expect(content(answer)["registry"]).toEqual({ status: value });
			// O12: not `0` — `0` is a claim, `null` is the truth while the registry cannot attest state (R11).
			expect(content(answer)["mirror"]).toEqual({ visibleAndMirroredChannelCount: null });
			// No channel list is read while the status is not current, so no count comes from unverifiable state.
			expect(requesterReads).toBe(0);
			expect(botReads).toBe(0);
			// R8's identity read is allowed while the registry is `stale`; the other states attest nothing.
			expect(content(answer)["guild"]).toEqual(
				value === "stale" ? { name: GUILD_NAME, id: GUILD_ID } : { name: null, id: null }
			);
		}
	);

	it("answers nulls for a registry that holds no Guild row yet", async () => {
		// O11's resolved case: `GetGuildIdentityQuery` answers `not-registered` on a fresh Installation. The
		// contract result is supplied directly because the registry rows of this fixture must stay intact for
		// the axes; the two nulls are the whole assertion.
		const notRegistered = new GetHubStatusQuery(
			statusReader,
			{ execute: async () => ({ status: "not-registered", guildId: GUILD_ID }) },
			new QueryAccessPolicy(statusReader, registry),
			bot,
			BOT_USER_ID
		);
		const answer = (await notRegistered.execute({
			userId: REQUESTER_ID,
			pageSize: 20,
			windowSize: 20
		})) as unknown as { guild: { name: string | null; id: string | null }; registry: { status: string } };
		expect(answer.guild).toEqual({ name: null, id: null });
		expect(answer.registry).toEqual({ status: "current" });
		// Never a placeholder string: the answer is null, not R8's wording and not the configured Guild id.
		expect(JSON.stringify(answer)).not.toContain("Guild not yet identified");
		expect(JSON.stringify(answer.guild)).not.toContain(GUILD_ID);
	});

	it("answers internal_error, never state_unavailable, when the status read fails", async () => {
		registryStatus = "throw";
		expect(await hubStatus()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { data: [], error: { code: "internal_error" } }
			}
		});
		expect(requesterReads).toBe(0);
		expect(botReads).toBe(0);
	});

	it.each(["requester", "bot"] as const)("answers internal_error when the %s axis fails", async (axis) => {
		if (axis === "requester") registryFails = true;
		else botFails = true;
		expect(await hubStatus()).toMatchObject({
			result: {
				isError: true,
				structuredContent: { data: [], error: { code: "internal_error" } }
			}
		});
	});

	it("rejects any argument field with invalid_input before reading anything", async () => {
		const answer = await hubStatus({ channelId: CHANNEL_ALPHA });
		expect(answer).toMatchObject({
			result: {
				isError: true,
				structuredContent: {
					data: [],
					error: { code: "invalid_input", message: "Unsupported field: channelId" }
				}
			}
		});
		expect(requesterReads).toBe(0);
		expect(botReads).toBe(0);
	});
});
