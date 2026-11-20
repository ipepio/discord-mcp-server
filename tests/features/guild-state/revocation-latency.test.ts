import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import { InMemoryGuildResyncLedger } from "../../../src/features/guild-state/bootstrap/in-memory-resync-ledger.js";
import { EndMembershipCommand } from "../../../src/features/guild-state/commands/end-membership.command.js";
import { GetGuildStateStatusQuery } from "../../../src/features/guild-state/queries/get-guild-state-status.query.js";
import { EvaluateEffectivePermissionsQuery } from "../../../src/features/guild-state/queries/evaluate-effective-permissions.query.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../../../src/features/guild-state/models/domain/discord-identifier.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import {
	FakePermissionSnapshotRepository,
	channelRow,
	membershipRow,
	roleRow,
	snapshotFixture
} from "./fakes/permission-snapshot-fixture.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * R12 — revocation latency, stated as the absence it is (docs/features/guild-state.md R12; ADR 0005).
 *
 * "A Discord permission change becomes effective in the registry within seconds of the bot receiving the
 * corresponding event: applied state is authoritative immediately, and no TTL cache of permission data
 * exists." The rule has two testable halves, and both are proven here rather than described:
 *
 * 1. **A revocation is visible on the very next evaluation.** One clock advance — none at all — is enough: the
 *    membership-end command writes the registry, and the next call over the same snapshot contract answers
 *    `membership-not-registered`. The gap between a permission change becoming effective and Gateway event
 *    latency is exactly one read, so the assertion is about the *immediate next call*, not a waited interval.
 * 2. **No TTL vocabulary exists in this feature.** There is no expiry, freshness window, max age or time-to-live
 *    anywhere in `src/features/guild-state`, and no clock is a dependency of the resync path or the status
 *    query. That is what makes the first half durable: a cached answer with a window would make "the next call"
 *    and "the current state" different questions, and this feature must never be able to ask the first one.
 */

const GUILD_ID: DiscordIdentifier = "160000000000000001";
const USER_ID: DiscordIdentifier = "160000000000000101";
const ROLE_BACKEND: DiscordIdentifier = "160000000000000010";
const CHANNEL_ID: DiscordIdentifier = "160000000000000201";
const VIEW = "1024";

const FEATURE_ROOT = join(process.cwd(), "src", "features", "guild-state");

function sourcesUnder(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			return sourcesUnder(path);
		}
		return entry.endsWith(".ts") ? [path] : [];
	});
}

function statusHarness() {
	const logger = new RecordingLogger();
	const registries = new RecordingRegistries();
	const config = createGuildStateConfig({ guildId: GUILD_ID });
	const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
	const ledger = new InMemoryGuildResyncLedger({ guildId: GUILD_ID });
	const status = new GetGuildStateStatusQuery({
		config,
		tracker,
		ledger,
		guildRegistry: registries.guildsContract,
		logger
	});
	const ends = new EndMembershipCommand({ config, membershipRegistry: registries.membershipsContract, logger });
	return { logger, registries, tracker, ledger, status, ends };
}

describe("R12 — revocation latency: applied state is authoritative on the next call", () => {
	it("a membership end changes the very next evaluation, with no interval to wait for", async () => {
		const snapshots = new FakePermissionSnapshotRepository({
			snapshot: snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ID,
				everyone: "0",
				membership: membershipRow(GUILD_ID, USER_ID, [ROLE_BACKEND]),
				roles: [roleRow(ROLE_BACKEND, VIEW)],
				channels: [channelRow(GUILD_ID, CHANNEL_ID)]
			})
		});
		const evaluation = new EvaluateEffectivePermissionsQuery({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			snapshot: snapshots,
			logger: new RecordingLogger()
		});

		const before = await evaluation.execute({ userId: USER_ID, channelId: CHANNEL_ID });
		expect(before.status).toBe("evaluated");
		expect(before.permissions.has("view-channel")).toBe(true);

		// The event is applied — the registry row is gone — and the projection read reflects it from here on.
		snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ID,
				everyone: "0",
				membership: null,
				roles: [roleRow(ROLE_BACKEND, VIEW)],
				channels: [channelRow(GUILD_ID, CHANNEL_ID)]
			})
		);

		// The same instant, the next call: latency is one read, never a window.
		const after = await evaluation.execute({ userId: USER_ID, channelId: CHANNEL_ID });
		expect(after.status).toBe("empty");
		expect(after.reason).toBe("membership-not-registered");
		expect(after.permissions.has("view-channel")).toBe(false);
		expect(snapshots.requests).toHaveLength(2);
	});

	it("repeated evaluation at one instant is the same answer and reads once per call (R13)", async () => {
		const snapshots = new FakePermissionSnapshotRepository({
			snapshot: snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ID,
				everyone: "0",
				membership: membershipRow(GUILD_ID, USER_ID, [ROLE_BACKEND]),
				roles: [roleRow(ROLE_BACKEND, VIEW)],
				channels: [channelRow(GUILD_ID, CHANNEL_ID)]
			})
		});
		const evaluation = new EvaluateEffectivePermissionsQuery({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			snapshot: snapshots,
			logger: new RecordingLogger()
		});

		const first = await evaluation.execute({ userId: USER_ID, channelId: CHANNEL_ID });
		const second = await evaluation.execute({ userId: USER_ID, channelId: CHANNEL_ID });

		expect(second.permissions.bitfield).toBe(first.permissions.bitfield);
		expect(snapshots.requests).toHaveLength(2);
	});

	it("the registry status needs no clock: an applied revocation and a resync flip it with no time involved", async () => {
		const scope = statusHarness();
		expect((await scope.status.execute()).status).toBe("incomplete");

		// Nothing here advances a clock: the status is a derivation of what has been applied and what is open.
		scope.tracker.markApplied("guild");
		scope.tracker.markApplied("roles");
		scope.tracker.markApplied("channels");
		scope.tracker.markApplied("roster");
		scope.tracker.markApplied("thread-members");
		await scope.registries.guildsContract.upsertGuild({ guildId: GUILD_ID, guildName: "Example Guild HQ" });
		expect((await scope.status.execute()).status).toBe("current");

		scope.ledger.recordGap({
			kind: "role-id-deferred",
			resourceId: ROLE_BACKEND,
			reason: "role row absent at the FK boundary"
		});
		expect((await scope.status.execute()).status).toBe("stale");

		scope.ledger.resolveGap("role-id-deferred", ROLE_BACKEND);
		expect((await scope.status.execute()).status).toBe("current");
	});
});

describe("R12 — the negative proof: no TTL cache exists in this feature", () => {
	const FORBIDDEN = /ttl|time[_-]?to[_-]?live|expiry|expire[dD]?|max[_-]?age|freshness[_-]?window|cache[_-]?window/i;

	it("names no ttl, expiry, max age or freshness window anywhere in guild-state", () => {
		const offenders = sourcesUnder(FEATURE_ROOT)
			.map((path) => ({ path, lines: readFileSync(path, "utf8").split("\n") }))
			.flatMap((file) =>
				file.lines
					.map((line, index) => ({ line, index }))
					// A comment that *states* the rule is not an implementation of it: only code identifiers count.
					.filter((entry) => FORBIDDEN.test(entry.line) && !/^\s*(\*|\/\/|\/\*)/.test(entry.line))
					.map((entry) => `${file.path}:${entry.index + 1}: ${entry.line.trim()}`)
			);

		expect(offenders).toEqual([]);
	});

	it("takes no clock, and the resync and status surfaces expose no time-window field", () => {
		const scope = statusHarness();
		const status = scope.status;
		const resyncState = scope.ledger.snapshot();

		expect(status).not.toHaveProperty("clock");
		expect(JSON.stringify(resyncState)).toEqual(
			JSON.stringify({
				guildId: GUILD_ID,
				resyncInFlight: false,
				resyncEpoch: null,
				convergedEpoch: null,
				unavailable: false,
				unavailableReason: null,
				openGaps: [],
				anomalyCounts: {}
			})
		);

		const keys = Object.keys(scope.registries.writes).concat(Object.keys(scope.tracker.snapshot()));
		expect(keys.filter((key) => FORBIDDEN.test(key))).toEqual([]);
	});
});
