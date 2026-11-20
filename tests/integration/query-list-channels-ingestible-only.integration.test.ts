import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QueryAccessPolicy } from "../../src/features/query/queries/query-access.policy.js";
import type { RegistryAccessReader } from "../../src/features/query/queries/query-access.policy.js";
import { ListChannelsQuery } from "../../src/features/query/queries/list-channels.query.js";
import type { BotViewableChannelsReader } from "../../src/features/query/queries/list-channels.query.js";
import { QueryToolsAdapter } from "../../src/features/query/mcp/query-tools.adapter.js";
import type { QueryToolHandlers } from "../../src/features/query/mcp/query-tools.adapter.js";
import { createGuildStateConfig } from "../../src/features/guild-state/config/guild-state-config.interface.js";
import { PostgresGuildRegistryRepository } from "../../src/features/guild-state/repositories/postgres-guild-registry.repository.js";
import { PostgresRoleRegistryRepository } from "../../src/features/guild-state/repositories/postgres-role-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-membership-registry.repository.js";
import { PostgresChannelRegistryRepository } from "../../src/features/guild-state/repositories/postgres-channel-registry.repository.js";
import { PostgresPermissionSnapshotRepository } from "../../src/features/guild-state/repositories/postgres-permission-snapshot.repository.js";
import { ListUserAccessibleChannelsQuery } from "../../src/features/guild-state/queries/list-user-accessible-channels.query.js";
import { ListIngestibleChannelsQuery } from "../../src/features/guild-state/queries/list-ingestible-channels.query.js";
import type { RegistryChannel, RegistryRole } from "../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "../features/guild-state/fakes/recording-logger.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";

/**
 * R12 evidence — `list_channels` lists only the intersection of the Requester's viewable entries and the
 * bot's own viewable entries (docs/features/query.md R12, T2 as amended; owner decision D1). The named test
 * of the specification's "Implementation and proof" is this suite's name.
 *
 * Both axes are the real guild-state contracts over real registry rows in an isolated PostgreSQL database:
 * `ListUserAccessibleChannelsQuery` for the Requester and `ListIngestibleChannelsQuery` for the bot, the
 * second one being the contract ingestion enumerates from. Nothing here re-derives bot access, reads the
 * ingestible contract's tables from the query feature, or adds a per-entry flag: the whole point of D1 is
 * that a channel the bot does not mirror is absent, indistinguishably from a channel the Requester cannot
 * see (R3).
 *
 * The fixture is this suite's own Guild, channels, memberships and messages, removed by `resetRegistry` and
 * `resetMessageStore` between cases and by dropping the generated database at the end.
 */

const GUILD_ID = "180000000000000001";
const REQUESTER_ID = "180000000000000101";
const BOT_USER_ID = "180000000000000109";

/** Both views: @everyone holds the bits every stage starts from. */
const VIEW = "1024";
const HISTORY = "65536";

/** Same position as `CHANNEL_ALPHA`, larger id: `(position, channelId)` ordering, not position alone. */
const CHANNEL_ALPHA = "180000000000000201";
const CHANNEL_ZETA = "180000000000000299";
/** The Requester can view it; the bot cannot — R12's first absence. */
const CHANNEL_BETA = "180000000000000202";
/** The bot can view it; the Requester cannot — R12's second absence. */
const CHANNEL_GAMMA = "180000000000000203";
/** Both can view it and no message was ever stored in it — R12's boundary case. */
const CHANNEL_EMPTY = "180000000000000204";
/** Non-text-capable rows the Requester can view: never mirrored, so never listed. */
const CHANNEL_VOICE = "180000000000000205";
const CHANNEL_CATEGORY = "180000000000000206";

const identity = { userId: REQUESTER_ID, sessionId: "guard-resolved", expiresAt: new Date("2099-01-01") };

describe.skipIf(!HAS_TEST_DATABASE)("list-channels-ingestible-only (R12, real PostgreSQL registry)", () => {
	let database: IsolatedTestDatabase;
	let guilds: PostgresGuildRegistryRepository;
	let roles: PostgresRoleRegistryRepository;
	let members: PostgresMembershipRegistryRepository;
	let channels: PostgresChannelRegistryRepository;
	let listForUser: ListUserAccessibleChannelsQuery;
	let listIngestible: ListIngestibleChannelsQuery;
	/** Injected failures: the two axes are real queries except when a case asks one of them to break. */
	let visibilityFails: boolean;
	let botAccessFails: boolean;
	let adapter: QueryToolsAdapter;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("query_ingestible_only");
		const logger = new RecordingLogger();
		const config = createGuildStateConfig({ guildId: GUILD_ID });
		guilds = new PostgresGuildRegistryRepository({ executor: database.executor });
		roles = new PostgresRoleRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		members = new PostgresMembershipRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		channels = new PostgresChannelRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		const snapshots = new PostgresPermissionSnapshotRepository({ executor: database.executor });
		listForUser = new ListUserAccessibleChannelsQuery({ config, snapshot: snapshots, logger });
		listIngestible = new ListIngestibleChannelsQuery({ config, snapshot: snapshots, logger });
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
		position: number,
		parentChannelId: string | null = null
	): RegistryChannel => ({
		guildId: GUILD_ID,
		channelId,
		channelType,
		name: `channel-${channelId.slice(-3)}`,
		position,
		parentChannelId
	});

	/**
	 * `betaDeniedTo` selects which side of the D1 decision is refused #beta: the bot (the default fixture,
	 * where the channel is not mirrored) or the Requester (where it is mirrored but unreadable). The two
	 * states differ in nothing but that fact, which is what makes the payloads comparable.
	 */
	async function applyRegistry(betaDeniedTo: "bot" | "requester" = "bot") {
		await database.resetRegistry();
		await database.resetMessageStore();
		await guilds.upsertGuild({ guildId: GUILD_ID, guildName: "Intersection guild" });
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
			channel(CHANNEL_EMPTY, "guild-text", 4),
			channel(CHANNEL_VOICE, "guild-voice", 5)
		]);
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_BETA,
			overwrites:
				betaDeniedTo === "bot"
					? [{ targetId: BOT_USER_ID, targetType: "member", allowBitfield: "0", denyBitfield: VIEW }]
					: [{ targetId: REQUESTER_ID, targetType: "member", allowBitfield: "0", denyBitfield: VIEW }]
		});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_GAMMA,
			overwrites: [{ targetId: REQUESTER_ID, targetType: "member", allowBitfield: "0", denyBitfield: VIEW }]
		});
		await database.pool.query(
			`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant) VALUES
 ($1,$4,$5,$6,'default','mirrored','2026-01-01'),
 ($2,$4,$7,$6,'default','not mirrored','2026-01-02'),
 ($3,$4,$8,$6,'default','not readable','2026-01-03')`,
			[
				"180000000000000301",
				"180000000000000302",
				"180000000000000303",
				GUILD_ID,
				CHANNEL_ALPHA,
				REQUESTER_ID,
				CHANNEL_BETA,
				CHANNEL_GAMMA
			]
		);
		visibilityFails = false;
		botAccessFails = false;
		adapter = new QueryToolsAdapter(buildHandlers());
	}

	/**
	 * The composition under test, as the module wires it: the access policy over the Requester axis, the real
	 * ingestible contract as the bot axis, and the bot's User id supplied by configuration.
	 */
	function buildHandlers(): QueryToolHandlers {
		const registry: RegistryAccessReader = {
			execute: async (input) => {
				if (visibilityFails) throw new Error("registry read failed");
				const listed = await listForUser.execute(input);
				// guild-state stores `channel_name`/`channel_position` as nullable columns; this fixture always
				// writes both, and the seam's entry requires them.
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
		const bot: BotViewableChannelsReader = {
			execute: async (input) => {
				if (botAccessFails) throw new Error("ingestible-channel read failed");
				const listed = await listIngestible.execute(input);
				return {
					channels: listed.channels,
					botCannotViewChannelIds: listed.botCannotViewChannelIds,
					botMembershipRegistered: listed.botMembershipRegistered
				};
			}
		};
		const listChannels = new ListChannelsQuery(
			new QueryAccessPolicy({ execute: async () => ({ guildId: GUILD_ID, status: "current" }) }, registry),
			bot,
			BOT_USER_ID
		);
		const unused = { execute: async () => ({ data: [] }) };
		return {
			list_channels: listChannels,
			search_messages: unused,
			get_channel_history: unused,
			get_thread_messages: unused,
			get_message_context: unused,
			get_recent_activity: unused,
			get_hub_status: unused
		};
	}

	/** One `tools/call` on the public surface: the page an agent actually receives. */
	function page(args: Record<string, unknown> = {}) {
		return adapter.handle(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_channels", arguments: args } },
			identity
		);
	}
	function ids(result: unknown): readonly string[] {
		const structured = (result as { result: { structuredContent: { data: { channelId: string }[] } } }).result
			.structuredContent;
		return structured.data.map((entry) => entry.channelId);
	}

	beforeEach(async () => {
		await applyRegistry();
	});

	it("lists the Requester's viewable channels the bot also views, and nothing else", async () => {
		const result = await page();
		expect(ids(result)).toEqual([CHANNEL_ALPHA, CHANNEL_ZETA, CHANNEL_EMPTY]);
		// The entry shape is T2's: no readability field, no `ingested` flag, no `botCanView` boolean (R12).
		expect(
			(result as { result: { structuredContent: { data: unknown[] } } }).result.structuredContent.data[0]
		).toEqual({
			channelId: CHANNEL_ALPHA,
			name: "channel-201",
			kind: "channel",
			parentChannelId: null,
			position: 1
		});
	});

	it("omits a channel the Requester can view but the bot cannot", async () => {
		// The absent fact is real, not vacuous: the Requester axis lists #beta and the bot axis refuses it.
		expect((await listForUser.execute({ userId: REQUESTER_ID })).channels.map((e) => e.channelId)).toContain(
			CHANNEL_BETA
		);
		const ingestible = await listIngestible.execute({ botUserId: BOT_USER_ID });
		expect(ingestible.channels.map((entry) => entry.channelId)).not.toContain(CHANNEL_BETA);
		expect(ingestible.botCannotViewChannelIds).toContain(CHANNEL_BETA);

		const result = await page();
		expect(ids(result)).not.toContain(CHANNEL_BETA);
	});

	it("omits a channel the bot can view but the Requester cannot", async () => {
		const ingestible = await listIngestible.execute({ botUserId: BOT_USER_ID });
		expect(ingestible.channels.map((entry) => entry.channelId)).toContain(CHANNEL_GAMMA);
		expect((await listForUser.execute({ userId: REQUESTER_ID })).channels.map((e) => e.channelId)).not.toContain(
			CHANNEL_GAMMA
		);

		const result = await page();
		expect(ids(result)).not.toContain(CHANNEL_GAMMA);
	});

	it("makes the two absences indistinguishable in the payload", async () => {
		const botCannotView = await page();

		// Same channel, same position, same messages: only the refused side changes (#beta denied to the
		// Requester instead of to the bot). R3 forbids any observable difference between the two absences.
		await applyRegistry("requester");
		const requesterCannotView = await page();

		expect(ids(botCannotView)).not.toContain(CHANNEL_BETA);
		expect(ids(requesterCannotView)).not.toContain(CHANNEL_BETA);
		expect(JSON.stringify(requesterCannotView)).toEqual(JSON.stringify(botCannotView));
	});

	it("never lists non-text-capable registry rows the Requester can view", async () => {
		// Both rows are viewable: the exclusion is the ingestible contract's text-capability rule, not a second
		// rule of this feature (R12 "Non-text-capable registry rows ... leave the list").
		const visible = (await listForUser.execute({ userId: REQUESTER_ID })).channels.map((entry) => entry.channelId);
		expect(visible).toEqual(expect.arrayContaining([CHANNEL_CATEGORY, CHANNEL_VOICE]));

		const result = await page();
		expect(ids(result)).not.toContain(CHANNEL_CATEGORY);
		expect(ids(result)).not.toContain(CHANNEL_VOICE);
	});

	it("lists a bot-viewable channel that has zero stored messages", async () => {
		const { rows } = await database.pool.query<{ total: string }>(
			"SELECT COUNT(*) AS total FROM message WHERE channel_id = $1",
			[CHANNEL_EMPTY]
		);
		expect(rows[0]?.total).toBe("0");

		expect(ids(await page())).toContain(CHANNEL_EMPTY);
	});

	it("answers internal_error with zero rows when either axis fails", async () => {
		for (const failure of ["visibility", "bot-access"] as const) {
			if (failure === "visibility") visibilityFails = true;
			else botAccessFails = true;

			expect(await page()).toMatchObject({
				result: {
					isError: true,
					structuredContent: { data: [], error: { code: "internal_error" } }
				}
			});

			visibilityFails = false;
			botAccessFails = false;
		}

		// The contract's third bot fact: the registry never stored the bot's own Membership, so its visibility
		// is unknown rather than empty, and an empty page would answer a different question (R12, R2).
		await members.deleteMembershipAndDependents(GUILD_ID, BOT_USER_ID);
		expect((await listIngestible.execute({ botUserId: BOT_USER_ID })).botMembershipRegistered).toBe(false);
		expect(await page()).toMatchObject({
			result: { isError: true, structuredContent: { data: [], error: { code: "internal_error" } } }
		});
	});

	it("keeps (position, channelId) ordering and R4 pagination over the intersection", async () => {
		const first = await page({ pageSize: 2 });
		expect(ids(first)).toEqual([CHANNEL_ALPHA, CHANNEL_ZETA]);
		const firstPage = (
			first as {
				result: {
					structuredContent: { pagination: { pageSize: number; hasNext: boolean; nextCursor: string } };
				};
			}
		).result.structuredContent.pagination;
		expect(firstPage).toMatchObject({ pageSize: 2, hasNext: true });
		expect(typeof firstPage.nextCursor).toBe("string");

		const second = await page({ pageSize: 2, cursor: firstPage.nextCursor });
		expect(ids(second)).toEqual([CHANNEL_EMPTY]);
		expect(
			(second as { result: { structuredContent: { pagination: unknown } } }).result.structuredContent.pagination
		).toEqual({ pageSize: 2, hasNext: false, nextCursor: null });
	});
});
