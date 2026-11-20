import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import type { ChannelPermissionOverwrite } from "../../src/features/discord/index.js";
import { PostgresChannelRegistryRepository } from "../../src/features/guild-state/repositories/postgres-channel-registry.repository.js";
import { PostgresGuildRegistryRepository } from "../../src/features/guild-state/repositories/postgres-guild-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-membership-registry.repository.js";
import { PostgresPermissionSnapshotRepository } from "../../src/features/guild-state/repositories/postgres-permission-snapshot.repository.js";
import { PostgresRoleRegistryRepository } from "../../src/features/guild-state/repositories/postgres-role-registry.repository.js";
import type { PermissionSnapshotRepository } from "../../src/features/guild-state/repositories/permission-snapshot.repository.js";
import { UpsertChannelCommand } from "../../src/features/guild-state/commands/upsert-channel.command.js";
import { createGuildStateConfig } from "../../src/features/guild-state/config/guild-state-config.interface.js";
import { ChannelsIngestibilityGainedPort } from "../../src/features/guild-state/gateways/channels-ingestibility-gained.port.js";
import { BackfillChannelHistoryCommand } from "../../src/features/ingestion/commands/backfill-channel-history.command.js";
import { BackfillChannelAccessCommand } from "../../src/features/ingestion/commands/backfill-channel-access.command.js";
import { createIngestionConfig } from "../../src/features/ingestion/config/ingestion-config.interface.js";
import { PostgresMessageStoreRepository } from "../../src/features/ingestion/repositories/postgres-message-store.repository.js";
import type { MessageHistoryGateway } from "../../src/features/ingestion/gateways/message-history-gateway.interface.js";
import type { DiscordIdentifier } from "../../src/features/guild-state/models/domain/discord-identifier.js";
import type { RegistryChannel } from "../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger as IngestionRecordingLogger } from "../features/ingestion/fakes/recording-logger.js";
import { RecordingLogger as GuildStateRecordingLogger } from "../features/guild-state/fakes/recording-logger.js";

/**
 * The channel-access trigger, end to end (`odd/tasks/ingestion-channel-access-trigger.md` S1, S2, S4, S6).
 *
 * The unit suite (`tests/features/guild-state/channel-access-trigger.test.ts`) proves the decision; this file
 * proves the two things only a real PostgreSQL can: that the before/after evaluation reads the state the
 * overwrite replacement really stored, and that the triggered backfill really leaves history rows in the
 * message store.
 *
 * The composition is the production one, wired by hand because this is a harness: guild-state's
 * `UpsertChannelCommand` owns the registry write and the transition, its outbound
 * {@link ChannelsIngestibilityGainedPort} is bound to ingestion's `BackfillChannelAccessCommand`, and the
 * binding here runs the job the way `application-lifecycle.ts` does — the listener returns immediately and
 * the walk finishes on its own promise, so an event application is never blocked by a history read. Awaiting
 * those promises afterwards is what makes the evidence deterministic without changing what is being proven.
 *
 * Five named cases, in the order S2 states the rule: a gained view backfills; a rename does not; a lost view
 * does not; a create that is already viewable backfills; a create that is not does not. Replaying the
 * granting event additionally proves S4 (a second delivery stores nothing and triggers nothing).
 *
 * Without `TEST_DATABASE_URL` this suite is skipped and the harness prints the UNAVAILABLE banner; skipped is
 * missing evidence, never a pass.
 */

const GUILD_ID = "170000000000000001";
const BOT_USER = "170000000000000100";
const CHANNEL_EXISTING = "170000000000000201";
const CHANNEL_RENAMED = "170000000000000202";
const CHANNEL_REVOKED = "170000000000000203";
const CHANNEL_CREATED_VIEWABLE = "170000000000000204";
const CHANNEL_CREATED_HIDDEN = "170000000000000205";

const VIEW_CHANNEL = "1024";

/** Every stored message message this suite ever reads back, named per channel so a case cannot borrow another's. */
const MESSAGE_IDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	[CHANNEL_EXISTING]: ["170000000000000401", "170000000000000402"],
	[CHANNEL_CREATED_VIEWABLE]: ["170000000000000403", "170000000000000404"],
	[CHANNEL_REVOKED]: ["170000000000000405"],
	[CHANNEL_RENAMED]: ["170000000000000406"],
	[CHANNEL_CREATED_HIDDEN]: ["170000000000000407"]
});

function channelRow(channelId: DiscordIdentifier, channelType: RegistryChannel["channelType"]): RegistryChannel {
	return {
		guildId: GUILD_ID,
		channelId,
		channelType,
		name: `channel-${channelId}`,
		position: 0,
		parentChannelId: null
	};
}

/** The history seam: whatever the fixture says was posted in that channel, on one exhausted page. */
function historyGateway(): MessageHistoryGateway {
	return {
		readMessageHistoryPage: async (read) => ({
			channelId: read.channelId,
			requestedLimit: read.limit ?? 50,
			hasMore: false,
			messages: (MESSAGE_IDS[read.channelId] ?? []).map((messageId, index) => ({
				messageId,
				channelId: read.channelId,
				authorId: BOT_USER,
				content: `history-${messageId}`,
				createdInstant: new Date(`2026-03-0${index + 1}T10:00:00.000Z`),
				messageType: "default" as const
			}))
		})
	};
}

/** A member-targeted overwrite for the bot: `allow` grants `view-channel`, `deny` withdraws it (stage 5). */
function botOverwrite(mode: "allow" | "deny"): ChannelPermissionOverwrite {
	return {
		targetId: BOT_USER,
		targetType: "member",
		allowBitfield: mode === "allow" ? VIEW_CHANNEL : "0",
		denyBitfield: mode === "deny" ? VIEW_CHANNEL : "0"
	};
}

interface Subject {
	readonly database: IsolatedTestDatabase;
	readonly upsertChannel: UpsertChannelCommand;
	readonly backfill: BackfillChannelAccessCommand;
	readonly store: PostgresMessageStoreRepository;
	/** The bot's viewability reads this run issued, in order, so the before/after bound is provable. */
	readonly snapshotReads: { channelId: string | null }[];
	/** The channel ids the outbound port reported, in call order. */
	readonly gained: string[];
	/** The jobs the port started and this harness has not awaited yet. */
	readonly jobs: Promise<unknown>[];
	/** Reads the started jobs and lets them finish, the way the process's event loop would. */
	readonly settle: () => Promise<void>;
}

describe.skipIf(!HAS_TEST_DATABASE)("channel access trigger (real PostgreSQL, S1, S2, S4)", () => {
	let database: IsolatedTestDatabase;
	let subject: Subject;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("ingestion_channel_access");
	}, 180_000);

	afterAll(async () => {
		await database?.close();
	});

	beforeEach(async () => {
		await database.resetRegistry();
		await database.resetMessageStore();

		const executor = database.executor;
		const guildConfig = createGuildStateConfig({ guildId: GUILD_ID });
		const channels = new PostgresChannelRegistryRepository({ executor, writeBatchSize: 200 });

		// One registry, seeded the way the REST bootstrap would leave it: the Guild, an `@everyone` role that
		// grants nothing, the bot's own Membership, and the channels each case starts from.
		await new PostgresGuildRegistryRepository({ executor }).upsertGuild({
			guildId: GUILD_ID,
			guildName: "Example Guild"
		});
		await new PostgresRoleRegistryRepository({ executor, writeBatchSize: 200 }).upsertRoles([
			{ guildId: GUILD_ID, roleId: GUILD_ID, roleName: "@everyone", permissionsBitfield: "0", position: 0 }
		]);
		await new PostgresMembershipRegistryRepository({ executor, writeBatchSize: 200 }).upsertMemberships([
			{ guildId: GUILD_ID, userId: BOT_USER, roleIds: [] }
		]);
		await channels.upsertChannels([
			channelRow(CHANNEL_EXISTING, "guild-text"),
			channelRow(CHANNEL_RENAMED, "guild-text"),
			channelRow(CHANNEL_REVOKED, "guild-text")
		]);
		await channels.replaceChannelOverwrites({ guildId: GUILD_ID, channelId: CHANNEL_REVOKED, overwrites: [] });

		const snapshotReads: { channelId: string | null }[] = [];
		const realSnapshot = new PostgresPermissionSnapshotRepository({ executor });
		const snapshot: PermissionSnapshotRepository = {
			loadSnapshot: async (request) => {
				snapshotReads.push({ channelId: request.channelId });
				return realSnapshot.loadSnapshot(request);
			}
		};

		const guildStateLogger = new GuildStateRecordingLogger();
		const ingestionLogger = new IngestionRecordingLogger();
		const ingestionConfig = createIngestionConfig({
			guildId: GUILD_ID,
			history: { maxPagesPerChannel: 3 }
		});
		const store = new PostgresMessageStoreRepository({
			executor,
			writeBatchSize: 200,
			exclusionPageSize: 200
		});
		const backfill = new BackfillChannelHistoryCommand({
			config: ingestionConfig,
			messageStore: store,
			logger: ingestionLogger,
			history: historyGateway()
		});
		const accessBackfill = new BackfillChannelAccessCommand({
			config: ingestionConfig,
			backfill,
			logger: ingestionLogger
		});

		const gained: string[] = [];
		const jobs: Promise<unknown>[] = [];
		const port = new ChannelsIngestibilityGainedPort();
		// The lifecycle's shape: schedule and return, let the job finish on its own promise (S5).
		port.bind((channelId) => {
			gained.push(channelId);
			jobs.push(accessBackfill.execute({ channelId }));
		});

		subject = {
			database,
			store,
			backfill: accessBackfill,
			snapshotReads,
			gained,
			jobs,
			settle: async () => {
				await Promise.all(jobs);
			},
			upsertChannel: new UpsertChannelCommand({
				config: guildConfig,
				channelRegistry: channels,
				logger: guildStateLogger,
				accessTrigger: { botUserId: BOT_USER, snapshot, channelsIngestibilityGained: port }
			})
		};
	});

	it("channel-update-grants-view-backfills: the overwrite change that lets the bot in walks the channel's history", async () => {
		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_EXISTING,
			channelType: "guild-text",
			name: `channel-${CHANNEL_EXISTING}`,
			position: 0,
			permissionOverwrites: [botOverwrite("allow")]
		});

		expect(outcome).toMatchObject({
			status: "applied",
			channelId: CHANNEL_EXISTING,
			ingestibilityGained: true,
			accessTransition: { before: false, after: true, transition: "gained" }
		});
		// The job is the port's, not the command's: what proves the event application did not wait for it is
		// `application-lifecycle.test.ts`, where the backfill's promise is deliberately left unsettled.
		expect(subject.gained).toEqual([CHANNEL_EXISTING]);

		await subject.settle();

		expect(await database.countRows("message")).toBe(MESSAGE_IDS[CHANNEL_EXISTING]?.length);
		const [firstId] = MESSAGE_IDS[CHANNEL_EXISTING] ?? [];
		expect((await subject.store.findMessage(GUILD_ID, firstId ?? ""))?.content).toBe(`history-${firstId}`);

		// S4: replaying the same event is not a second trigger — the bot already had view — and a re-run of the
		// backfill itself stores 0 and touches nothing.
		const replay = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_EXISTING,
			channelType: "guild-text",
			name: `channel-${CHANNEL_EXISTING}`,
			position: 0,
			permissionOverwrites: [botOverwrite("allow")]
		});
		expect(replay).toMatchObject({ status: "applied", ingestibilityGained: false });
		expect(subject.gained).toEqual([CHANNEL_EXISTING]);
		const rerun = await subject.backfill.execute({ channelId: CHANNEL_EXISTING });
		expect(rerun.walk.messagesStored).toBe(0);
		expect(rerun.walk.messagesUnchanged).toBe(MESSAGE_IDS[CHANNEL_EXISTING]?.length);
		expect(await database.countRows("message")).toBe(MESSAGE_IDS[CHANNEL_EXISTING]?.length);
	});

	it("channel-update-rename-only-no-op: a rename that reports the same overwrite set starts nothing", async () => {
		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_RENAMED,
			channelType: "guild-text",
			name: "renamed-channel",
			position: 0,
			permissionOverwrites: []
		});
		await subject.settle();

		expect(outcome).toMatchObject({
			status: "applied",
			ingestibilityGained: false,
			accessTransition: { before: false, after: false, transition: "unchanged" }
		});
		expect(subject.gained).toEqual([]);
		expect(await database.countRows("message")).toBe(0);
		// The before/after pair really was evaluated against stored state: no trigger is a decision, not a skip.
		expect(subject.snapshotReads).toHaveLength(2);
	});

	it("channel-update-revokes-view-no-op: losing view starts nothing and leaves the registry converged", async () => {
		// The bot starts able to view this channel through a member-targeted grant.
		await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_REVOKED,
			channelType: "guild-text",
			permissionOverwrites: [botOverwrite("allow")]
		});
		await subject.settle();
		expect(subject.gained).toEqual([CHANNEL_REVOKED]);
		await subject.backfill.execute({ channelId: CHANNEL_REVOKED });
		await database.resetMessageStore();
		subject.gained.length = 0;
		subject.jobs.length = 0;

		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_REVOKED,
			channelType: "guild-text",
			permissionOverwrites: [botOverwrite("deny")]
		});
		await subject.settle();

		expect(outcome).toMatchObject({
			status: "applied",
			ingestibilityGained: false,
			accessTransition: { before: true, after: false, transition: "lost" }
		});
		expect(subject.gained).toEqual([]);
		expect(await database.countRows("message")).toBe(0);
	});

	it("channel-create-viewable-backfills: a new channel the bot can already view is walked, from one read", async () => {
		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_CREATED_VIEWABLE,
			channelType: "guild-text",
			name: "brand-new",
			position: 1,
			permissionOverwrites: [botOverwrite("allow")]
		});
		expect(outcome).toMatchObject({ status: "applied", created: true, ingestibilityGained: true });
		// A row the registry never held has no before-state to read: the create path evaluates once.
		expect(subject.snapshotReads).toHaveLength(1);

		await subject.settle();

		expect(subject.gained).toEqual([CHANNEL_CREATED_VIEWABLE]);
		expect(await database.countRows("message")).toBe(MESSAGE_IDS[CHANNEL_CREATED_VIEWABLE]?.length);
	});

	it("channel-create-not-viewable-no-op: a new channel the bot cannot view starts nothing", async () => {
		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_CREATED_HIDDEN,
			channelType: "guild-text",
			name: "hidden",
			position: 2,
			permissionOverwrites: []
		});
		await subject.settle();

		expect(outcome).toMatchObject({
			status: "applied",
			created: true,
			ingestibilityGained: false,
			accessTransition: { transition: "unchanged", before: false, after: false }
		});
		expect(subject.gained).toEqual([]);
		expect(await database.countRows("message")).toBe(0);
	});
});
