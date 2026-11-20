import { beforeEach, describe, expect, it } from "vitest";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../../../src/features/guild-state/models/domain/discord-identifier.js";
import { InvalidDiscordIdentifierError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import { EffectivePermissionEvaluationError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import { EvaluateEffectivePermissionsQuery } from "../../../src/features/guild-state/queries/evaluate-effective-permissions.query.js";
import { GetGuildIdentityQuery } from "../../../src/features/guild-state/queries/get-guild-identity.query.js";
import { GetMembershipStatusQuery } from "../../../src/features/guild-state/queries/get-membership-status.query.js";
import { ListIngestibleChannelsQuery } from "../../../src/features/guild-state/queries/list-ingestible-channels.query.js";
import { ListUserAccessibleChannelsQuery } from "../../../src/features/guild-state/queries/list-user-accessible-channels.query.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";
import {
	FakePermissionSnapshotRepository,
	channelRow,
	membershipRow,
	overwriteRow,
	roleRow,
	snapshotFixture
} from "./fakes/permission-snapshot-fixture.js";

/**
 * The four companion reads Contracts names alongside the evaluation (docs/features/guild-state.md:
 * `GetGuildIdentityQuery`, `GetMembershipStatusQuery`, `ListUserAccessibleChannelsQuery`,
 * `ListIngestibleChannelsQuery`). R13 governs all four: ids in, stored facts out, no write, no REST call.
 *
 * The two list queries carry the weight, because both are the "one bounded set read, never a per-channel
 * round-trip loop" the spec states, and both must derive from the same rule the single decision uses — a list
 * that disagrees with a decision would be an access bug with a friendlier shape.
 */

const GUILD_ID: DiscordIdentifier = "160000000000000001";
const USER_ID: DiscordIdentifier = "160000000000000101";
const BOT_ID: DiscordIdentifier = "160000000000000109";
const ROLE_ID: DiscordIdentifier = "160000000000000010";
const TEXT = "160000000000000201";
const VOICE = "160000000000000202";
const PARENT = "160000000000000203";
const THREAD = "160000000000000204";
const PRIVATE_THREAD = "160000000000000205";
const FORUM = "160000000000000206";

const VIEW = 1024n;
const HISTORY = 65536n;

describe("GetGuildIdentityQuery (Contracts, R2, R13)", () => {
	let registries: RecordingRegistries;
	let logger: RecordingLogger;
	let query: GetGuildIdentityQuery;

	beforeEach(() => {
		registries = new RecordingRegistries();
		logger = new RecordingLogger();
		query = new GetGuildIdentityQuery({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			guildRegistry: registries.guildsContract,
			logger
		});
	});

	it("answers from the stored row once the bootstrap has written it", async () => {
		await registries.guildsContract.upsertGuild({ guildId: GUILD_ID, guildName: "Example Guild" });

		expect(await query.execute()).toEqual({
			status: "registered",
			guild: { guildId: GUILD_ID, guildName: "Example Guild" }
		});
	});

	it("names an unbootstrapped registry as a state, not as an empty name", async () => {
		expect(await query.execute()).toEqual({ status: "not-registered", guildId: GUILD_ID });
	});

	it("reads and writes nothing of its own (R13)", async () => {
		await query.execute();
		await query.execute();
		expect(registries.writes).toEqual([]);
	});
});

describe("GetMembershipStatusQuery (Contracts, R4, R13)", () => {
	let registries: RecordingRegistries;
	let logger: RecordingLogger;
	let query: GetMembershipStatusQuery;

	beforeEach(() => {
		registries = new RecordingRegistries();
		logger = new RecordingLogger();
		query = new GetMembershipStatusQuery({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			membershipRegistry: registries.membershipsContract,
			logger
		});
	});

	it("answers present with the stored role count, @everyone excluded (R3)", async () => {
		await registries.membershipsContract.upsertMemberships([
			{ guildId: GUILD_ID, userId: USER_ID, roleIds: [ROLE_ID] }
		]);

		expect(await query.execute({ userId: USER_ID })).toEqual({
			guildId: GUILD_ID,
			userId: USER_ID,
			status: "present",
			roleCount: 1
		});
	});

	it("answers absent for an id the registry never held, and for one whose Membership ended (R4)", async () => {
		await registries.membershipsContract.upsertMemberships([membershipRow(GUILD_ID, USER_ID)]);
		expect((await query.execute({ userId: USER_ID })).status).toBe("present");

		await registries.membershipsContract.deleteMembershipAndDependents(GUILD_ID, USER_ID);
		expect(await query.execute({ userId: USER_ID })).toEqual({
			guildId: GUILD_ID,
			userId: USER_ID,
			status: "absent",
			roleCount: 0
		});
	});

	it("validates the id before it reads (R9)", async () => {
		await expect(query.execute({ userId: "0" })).rejects.toThrow(InvalidDiscordIdentifierError);
		expect(registries.writes).toEqual([]);
	});

	it("logs the fact and the count, never the role ids (R14)", async () => {
		await registries.membershipsContract.upsertMemberships([membershipRow(GUILD_ID, USER_ID, [ROLE_ID])]);
		await query.execute({ userId: USER_ID });

		const line = logger.linesAt("debug")[0];
		expect(line?.fields).toMatchObject({ operation: "get-membership-status", status: "present", roleCount: 1 });
		expect(logger.transcript()).not.toContain(ROLE_ID);
	});
});

describe("ListUserAccessibleChannelsQuery (Contracts, R12, R13)", () => {
	let snapshots: FakePermissionSnapshotRepository;
	let logger: RecordingLogger;
	let query: ListUserAccessibleChannelsQuery;

	const wideRegistry = () =>
		snapshotFixture({
			guildId: GUILD_ID,
			userId: USER_ID,
			everyone: String(VIEW),
			membership: membershipRow(GUILD_ID, USER_ID, [ROLE_ID]),
			roles: [roleRow(ROLE_ID, "0")],
			channels: [
				channelRow(GUILD_ID, TEXT),
				channelRow(GUILD_ID, VOICE, "guild-voice"),
				channelRow(GUILD_ID, PARENT),
				channelRow(GUILD_ID, THREAD, "public-thread", PARENT)
			],
			overwrites: [
				[TEXT, [overwriteRow(ROLE_ID, "role", HISTORY)]],
				[PARENT, [overwriteRow(EVERYONE_TARGET, "role", 0n, VIEW)]],
				[VOICE, [overwriteRow(EVERYONE_TARGET, "role", 0n, VIEW)]]
			]
		});

	const EVERYONE_TARGET = GUILD_ID;

	beforeEach(() => {
		snapshots = new FakePermissionSnapshotRepository({ snapshot: wideRegistry() });
		logger = new RecordingLogger();
		query = new ListUserAccessibleChannelsQuery({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			snapshot: snapshots,
			logger
		});
	});

	it("makes one wide snapshot read for the whole list, never one per channel (Contracts)", async () => {
		const listed = await query.execute({ userId: USER_ID });

		expect(snapshots.requests).toEqual([{ guildId: GUILD_ID, userId: USER_ID, channelId: null }]);
		expect(listed.evaluatedChannelCount).toBe(4);
	});

	it("lists what VIEW_CHANNEL grants, carrying the READ_MESSAGE_HISTORY fact per entry", async () => {
		const listed = await query.execute({ userId: USER_ID });

		expect(listed.channels.map((entry) => entry.channelId)).toEqual([TEXT]);
		expect(listed.channels[0]).toEqual({
			channelId: TEXT,
			channelType: "guild-text",
			name: null,
			position: null,
			isThread: false,
			parentChannelId: null,
			canReadMessageHistory: true
		});
		expect(listed.refusalReasons).toEqual([]);
	});

	it("reflects renamed registry metadata on the next read without changing position", async () => {
		const registry = wideRegistry();
		const withName = (name: string) => ({
			...registry,
			channels: registry.channels.map((entry) => ({ ...entry, name, position: 7 }))
		});
		snapshots.setSnapshot(withName("original"));
		expect((await query.execute({ userId: USER_ID })).channels[0]).toMatchObject({ name: "original", position: 7 });
		snapshots.setSnapshot(withName("renamed"));
		expect((await query.execute({ userId: USER_ID })).channels[0]).toMatchObject({ name: "renamed", position: 7 });
	});

	it("carries a thread it can see with its parent recorded (R6)", async () => {
		snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ID,
				everyone: String(VIEW),
				channels: [channelRow(GUILD_ID, PARENT), channelRow(GUILD_ID, THREAD, "public-thread", PARENT)]
			})
		);

		const listed = await query.execute({ userId: USER_ID });
		expect(listed.channels.map((entry) => [entry.channelId, entry.isThread, entry.parentChannelId])).toEqual([
			[PARENT, false, null],
			[THREAD, true, PARENT]
		]);
	});

	it("reports why nothing was readable, as the stored fact it is (R4, R8)", async () => {
		snapshots.setSnapshot(snapshotFixture({ guildId: GUILD_ID, userId: USER_ID, membership: null }));

		const listed = await query.execute({ userId: USER_ID });
		expect(listed.channels).toEqual([]);
		expect(listed.refusalReasons).toEqual(["membership-not-registered"]);
	});

	it("agrees with the single decision for the same channel and state (R12)", async () => {
		const listed = await query.execute({ userId: USER_ID });
		const evaluation = new EvaluateEffectivePermissionsQuery({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			snapshot: snapshots,
			logger
		});
		const decided = await evaluation.execute({ userId: USER_ID, channelId: THREAD });

		// The thread is under a parent whose @everyone row denies VIEW_CHANNEL, so both surfaces must say no:
		// the list leaves it out and the decision evaluates it to a set without the bit (R7, R12).
		expect(listed.channels.some((entry) => entry.channelId === THREAD)).toBe(false);
		expect(decided.permissions.has("view-channel")).toBe(false);
		expect(decided.overwriteLevels).toEqual([PARENT, THREAD]);

		const visible = await evaluation.execute({ userId: USER_ID, channelId: TEXT });
		expect(listed.channels.some((entry) => entry.channelId === TEXT)).toBe(visible.permissions.has("view-channel"));
		expect(visible.permissions.has("read-message-history")).toBe(
			listed.channels.find((entry) => entry.channelId === TEXT)?.canReadMessageHistory
		);
	});

	it("keeps a broken read a technical failure, not an empty list (R6)", async () => {
		snapshots.failNext(new Error("connection lost"));
		await expect(query.execute({ userId: USER_ID })).rejects.toThrow(EffectivePermissionEvaluationError);
		expect(logger.messagesMatching("could not read its snapshot").length).toBe(1);
	});

	it("logs counts and ids only (R14)", async () => {
		await query.execute({ userId: USER_ID });
		const transcript = logger.transcript();
		expect(transcript).toContain(USER_ID);
		expect(transcript).not.toContain(String(VIEW));
		expect(transcript).not.toContain("Test guild");
	});
});

describe("ListIngestibleChannelsQuery — the registry contract ingestion consumes (Contracts, ingestion R2)", () => {
	let snapshots: FakePermissionSnapshotRepository;
	let logger: RecordingLogger;
	let query: ListIngestibleChannelsQuery;

	function registry(overwrites: readonly (readonly [DiscordIdentifier, readonly unknown[]])[] = []) {
		return snapshotFixture({
			guildId: GUILD_ID,
			userId: BOT_ID,
			everyone: String(VIEW | HISTORY),
			membership: membershipRow(GUILD_ID, BOT_ID),
			channels: [
				channelRow(GUILD_ID, TEXT),
				channelRow(GUILD_ID, VOICE, "guild-voice"),
				channelRow(GUILD_ID, FORUM, "guild-forum"),
				channelRow(GUILD_ID, PARENT, "guild-category"),
				channelRow(GUILD_ID, THREAD, "public-thread", FORUM),
				channelRow(GUILD_ID, PRIVATE_THREAD, "private-thread", FORUM)
			],
			privateThreadIds: [PRIVATE_THREAD],
			overwrites: overwrites as never
		});
	}

	beforeEach(() => {
		snapshots = new FakePermissionSnapshotRepository({ snapshot: registry() });
		logger = new RecordingLogger();
		query = new ListIngestibleChannelsQuery({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			snapshot: snapshots,
			logger
		});
	});

	it("keeps the text-capable kinds and drops the ones that cannot carry a message (R6)", async () => {
		const listed = await query.execute({ botUserId: BOT_ID });

		expect(listed.channels.map((entry) => entry.channelId)).toEqual([TEXT, FORUM, THREAD, PRIVATE_THREAD]);
		expect(listed.channels.map((entry) => entry.isThread)).toEqual([false, false, true, true]);
		expect(listed.registeredTextCapableCount).toBe(4);
		expect(listed.botCannotViewChannelIds).toEqual([]);
		expect(listed.botMembershipRegistered).toBe(true);
	});

	it("reports lack of bot visibility as its own fact, distinct from absence from the registry (Contracts)", async () => {
		snapshots.setSnapshot(registry([[TEXT, [overwriteRow(GUILD_ID, "role", 0n, VIEW)]]]));

		const listed = await query.execute({ botUserId: BOT_ID });
		expect(listed.channels.map((entry) => entry.channelId)).toEqual([FORUM, THREAD, PRIVATE_THREAD]);
		expect(listed.botCannotViewChannelIds).toEqual([TEXT]);
		// Both denominators are still there, so a caller can tell "hidden from the bot" from "never stored".
		expect(listed.registeredTextCapableCount).toBe(4);
		expect(listed.refusalReasons).toEqual([]);
	});

	it("names a registry that never stored the bot's Membership, instead of an unexplained empty list (R4)", async () => {
		snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: BOT_ID,
				everyone: String(VIEW),
				membership: null,
				channels: [channelRow(GUILD_ID, TEXT)]
			})
		);

		const listed = await query.execute({ botUserId: BOT_ID });
		expect(listed.channels).toEqual([]);
		expect(listed.botMembershipRegistered).toBe(false);
		expect(listed.refusalReasons).toEqual(["membership-not-registered"]);
	});

	it("counts a private thread the bot is not a member of as registered-but-not-admitted (R8)", async () => {
		snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: BOT_ID,
				everyone: String(VIEW),
				channels: [channelRow(GUILD_ID, TEXT), channelRow(GUILD_ID, PRIVATE_THREAD, "private-thread", FORUM)]
			})
		);

		const listed = await query.execute({ botUserId: BOT_ID });
		expect(listed.channels.map((entry) => entry.channelId)).toEqual([TEXT]);
		expect(listed.botCannotViewChannelIds).toEqual([PRIVATE_THREAD]);
		expect(listed.registeredTextCapableCount).toBe(2);
	});

	it("makes one bounded pass over the whole registry (Contracts: never a per-thread call)", async () => {
		await query.execute({ botUserId: BOT_ID });
		await query.execute({ botUserId: BOT_ID });

		expect(snapshots.requests.length).toBe(2);
		expect(snapshots.wideRequests().length).toBe(2);
	});

	it("validates the bot id before reading, and logs ids and counts only (R9, R14)", async () => {
		await expect(query.execute({ botUserId: "-1" })).rejects.toThrow(InvalidDiscordIdentifierError);
		expect(snapshots.requests).toEqual([]);

		await query.execute({ botUserId: BOT_ID });
		expect(logger.transcript()).toContain("registeredTextCapableCount");
		expect(logger.transcript()).not.toContain(String(VIEW));
	});
});
