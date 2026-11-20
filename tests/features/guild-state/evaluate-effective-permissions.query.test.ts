import { beforeEach, describe, expect, it } from "vitest";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../../../src/features/guild-state/models/domain/discord-identifier.js";
import { InvalidDiscordIdentifierError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import { EffectivePermissionEvaluationError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import { EvaluateEffectivePermissionsQuery } from "../../../src/features/guild-state/queries/evaluate-effective-permissions.query.js";
import type { PermissionSnapshotRepository } from "../../../src/features/guild-state/repositories/permission-snapshot.repository.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import {
	FakePermissionSnapshotRepository,
	channelRow,
	membershipRow,
	overwriteRow,
	roleRow,
	snapshotFixture
} from "./fakes/permission-snapshot-fixture.js";

/**
 * The public use case around the derivation (docs/features/guild-state.md R12, R13; Contracts; R14). The
 * five stages are proven in `effective-permission-rules.test.ts`; what is proven here is the four things only
 * the use case can get wrong: which Guild a decision is taken under, how many reads one decision costs, the
 * line between "the registry says no" and "the hub could not decide", and what a log line may contain.
 */

const GUILD_ID: DiscordIdentifier = "160000000000000001";
const USER_ID: DiscordIdentifier = "160000000000000101";
const OTHER_USER_ID: DiscordIdentifier = "160000000000000102";
const ROLE_ID: DiscordIdentifier = "160000000000000010";
const CHANNEL_ID: DiscordIdentifier = "160000000000000201";
const VIEW = 1024n;
const HISTORY = 65536n;
const ADMINISTRATOR = 8n;

function build(snapshot: PermissionSnapshotRepository, logger = new RecordingLogger()) {
	return {
		logger,
		query: new EvaluateEffectivePermissionsQuery({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			snapshot,
			logger
		})
	};
}

describe("EvaluateEffectivePermissionsQuery — the contract around the rule (R12, R13)", () => {
	let snapshots: FakePermissionSnapshotRepository;
	let logger: RecordingLogger;
	let query: EvaluateEffectivePermissionsQuery;

	beforeEach(() => {
		snapshots = new FakePermissionSnapshotRepository({
			snapshot: snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ID,
				everyone: String(VIEW),
				membership: membershipRow(GUILD_ID, USER_ID, [ROLE_ID]),
				roles: [roleRow(ROLE_ID, "0")],
				overwrites: [[CHANNEL_ID, [overwriteRow(ROLE_ID, "role", HISTORY)]]]
			})
		});
		({ logger, query } = build(snapshots));
	});

	it("reads exactly one snapshot, in the narrow form, scoped to the configured Guild (R1, Contracts)", async () => {
		await query.execute({ userId: USER_ID, channelId: CHANNEL_ID });

		expect(snapshots.requests).toEqual([{ guildId: GUILD_ID, userId: USER_ID, channelId: CHANNEL_ID }]);
		expect(snapshots.requests.length).toBe(1);
	});

	it("answers with the exact decimal bitfield and the named lookups the spec promises", async () => {
		const decided = await query.execute({ userId: USER_ID, channelId: CHANNEL_ID });

		expect(decided.status).toBe("evaluated");
		expect(decided.permissions.bitfield).toBe(String(VIEW | HISTORY));
		expect(decided.permissions.has("view-channel")).toBe(true);
		expect(decided.permissions.has("read-message-history")).toBe(true);
		expect(decided.permissions.has("send-messages")).toBe(false);
		expect(decided.permissions.granted).toEqual(["view-channel", "read-message-history"]);
	});

	it("grants everything to an administrator without touching the overwrite rows", async () => {
		snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ID,
				everyone: String(ADMINISTRATOR),
				overwrites: [[CHANNEL_ID, [overwriteRow(USER_ID, "member", 0n, ADMINISTRATOR)]]]
			})
		);
		const decided = await query.execute({ userId: USER_ID, channelId: CHANNEL_ID });

		expect(decided.administratorBypass).toBe(true);
		expect(decided.permissions.has("manage-guild")).toBe(true);
	});

	it("evaluates the same request twice with the same answer and no extra state (R13)", async () => {
		const first = await query.execute({ userId: USER_ID, channelId: CHANNEL_ID });
		const second = await query.execute({ userId: USER_ID, channelId: CHANNEL_ID });

		expect(second.permissions.bitfield).toBe(first.permissions.bitfield);
		expect(second.permissions.granted).toEqual(first.permissions.granted);
		// Two calls, two reads, and the read model has no write to call: the contract itself is the proof.
		expect(snapshots.requests.length).toBe(2);
	});

	it("rejects an id that is not a snowflake before it reads anything (R9, R13)", async () => {
		await expect(query.execute({ userId: "1=or 1=1", channelId: CHANNEL_ID })).rejects.toThrow(
			InvalidDiscordIdentifierError
		);
		await expect(query.execute({ userId: USER_ID, channelId: "" })).rejects.toThrow(InvalidDiscordIdentifierError);
		expect(snapshots.requests).toEqual([]);
	});

	it("takes the configured Guild as the scope, so a foreign id is simply not in the registry (R1)", async () => {
		const FOREIGN_CHANNEL: DiscordIdentifier = "160000000000000999";
		snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ID,
				everyone: String(VIEW),
				channels: [
					channelRow(GUILD_ID, CHANNEL_ID),
					channelRow("160000000000000777", FOREIGN_CHANNEL, "guild-text", null)
				]
			})
		);

		const decided = await query.execute({ userId: USER_ID, channelId: FOREIGN_CHANNEL });
		expect(decided.status).toBe("empty");
		expect(decided.reason).toBe("channel-not-registered");
		expect(decided.permissions.bitfield).toBe("0");
	});

	it("reports a user with no Membership as the empty set, not as an error (R4, R6)", async () => {
		snapshots.setSnapshot(snapshotFixture({ guildId: GUILD_ID, userId: USER_ID, membership: null }));

		const decided = await query.execute({ userId: OTHER_USER_ID, channelId: CHANNEL_ID });
		expect(decided.status).toBe("empty");
		expect(decided.reason).toBe("membership-not-registered");
		expect(logger.messagesMatching("failed closed").length).toBe(1);
		expect(logger.linesAt("error").length).toBe(0);
	});

	it("keeps a broken read a technical failure, never an empty set that reads as a denial", async () => {
		snapshots.failNext(new Error("connection lost"));

		await expect(query.execute({ userId: USER_ID, channelId: CHANNEL_ID })).rejects.toThrow(
			EffectivePermissionEvaluationError
		);
		const line = logger.linesAt("error")[0];
		expect(line?.fields["operation"]).toBe("evaluate");
		expect(line?.fields["failure"]).toBe("Error");
	});

	it("names a stored bitfield the registry cannot represent as a technical failure too (R3)", async () => {
		snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ID,
				everyone: "9.2e18",
				membership: membershipRow(GUILD_ID, USER_ID, [ROLE_ID]),
				roles: [roleRow(ROLE_ID, String(HISTORY))]
			})
		);

		await expect(query.execute({ userId: USER_ID, channelId: CHANNEL_ID })).rejects.toThrow(
			EffectivePermissionEvaluationError
		);
	});

	it("logs ids and counts only — no bitfield text, no names, no display data (R14)", async () => {
		await query.execute({ userId: USER_ID, channelId: CHANNEL_ID });
		await query.execute({ userId: OTHER_USER_ID, channelId: CHANNEL_ID });

		const transcript = logger.transcript();
		expect(transcript).toContain(GUILD_ID);
		expect(transcript).toContain(CHANNEL_ID);
		expect(transcript).not.toContain(String(VIEW | HISTORY));
		expect(transcript).not.toContain("Test guild");
		expect(transcript).not.toContain("bitfield");
	});
});
