import { describe, expect, it } from "vitest";
import { DeleteChannelCommand } from "../../../src/features/guild-state/commands/delete-channel.command.js";
import { DeleteRoleCommand } from "../../../src/features/guild-state/commands/delete-role.command.js";
import { SweepVanishedStateCommand } from "../../../src/features/guild-state/commands/sweep-vanished-state.command.js";
import type { GuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { ChannelPermissionOverwrite } from "../../../src/features/discord/index.js";
import type { VanishedStateReadSets } from "../../../src/features/guild-state/models/domain/vanished-state.js";
import { vanishedFromRead } from "../../../src/features/guild-state/models/domain/vanished-state.js";
import type { RegistryChannel } from "../../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T10 — the resync convergence sweep (`docs/features/guild-state.md` R11, with R2's roster bound, R3/R4/R6's
 * cascades, R9's idempotency and R14's logging rule).
 *
 * R11 is not only "re-read what Discord says"; it is "stop honouring what Discord stopped saying". A resync pass
 * writes every row the snapshot reported and, on its own, removes nothing — so the state that vanished during the
 * outage (a member who left, a role deleted, a channel deleted) survives as an authorization the provider has
 * already withdrawn. This file proves the remove-half, in isolation from the REST pass, over the same recording
 * doubles the delete commands are proven with: which rows a complete read no longer names, which cascade each
 * removed row went through, how many dependent rows came with it, and — the absolute case — that a roster which
 * stopped at its page bound sweeps nothing at all.
 */

const GUILD_ID = "170000000000000001";
const ROLE_BACKEND = "170000000000000010";
const ROLE_OPS = "170000000000000011";
const USER_ONE = "170000000000000101";
const USER_TWO = "170000000000000102";
const USER_THREE = "170000000000000103";
const CHANNEL_PRIVATE = "170000000000000201";
const CHANNEL_GONE = "170000000000000202";
const THREAD_GONE = "170000000000000203";
const OTHER_GUILD_ID = "179999999999999999";
const VIEW = "1024";
const SEND = "2048";

interface SweepHarness {
	readonly sweep: SweepVanishedStateCommand;
	readonly registries: RecordingRegistries;
	readonly logger: RecordingLogger;
	readonly config: GuildStateConfig;
}

function sweepHarness(
	options: { readonly writeBatchSize?: number; readonly registries?: RecordingRegistries } = {}
): SweepHarness {
	const config = createGuildStateConfig({
		guildId: GUILD_ID,
		...(options.writeBatchSize === undefined ? {} : { bootstrap: { writeBatchSize: options.writeBatchSize } })
	});
	const registries = options.registries ?? new RecordingRegistries();
	const logger = new RecordingLogger();
	const sweep = new SweepVanishedStateCommand({
		config,
		membershipRegistry: registries.membershipsContract,
		roleRegistry: registries.rolesContract,
		channelRegistry: registries.channelsContract,
		deleteRoleCommand: new DeleteRoleCommand({ config, roleRegistry: registries.rolesContract, logger }),
		deleteChannelCommand: new DeleteChannelCommand({
			config,
			channelRegistry: registries.channelsContract,
			logger
		}),
		logger
	});
	return { sweep, registries, logger, config };
}

/** The rows the registry holds before the sweep, written through the same doubles the sweep reads. */
async function seed(registries: RecordingRegistries): Promise<void> {
	await registries.guildsContract.upsertGuild({ guildId: GUILD_ID, guildName: "adr" });
	await registries.rolesContract.upsertRoles([
		{ guildId: GUILD_ID, roleId: GUILD_ID, roleName: "@everyone", permissionsBitfield: VIEW, position: 0 },
		{ guildId: GUILD_ID, roleId: ROLE_BACKEND, roleName: "backend", permissionsBitfield: SEND, position: 1 },
		{ guildId: GUILD_ID, roleId: ROLE_OPS, roleName: "ops", permissionsBitfield: VIEW, position: 2 }
	]);
	await registries.membershipsContract.upsertMemberships([
		{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] },
		{ guildId: GUILD_ID, userId: USER_TWO, roleIds: [ROLE_BACKEND, ROLE_OPS] },
		{ guildId: GUILD_ID, userId: USER_THREE, roleIds: [ROLE_OPS] }
	]);
	const channels: readonly RegistryChannel[] = [
		{
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private",
			position: 0,
			parentChannelId: null
		},
		{
			guildId: GUILD_ID,
			channelId: CHANNEL_GONE,
			channelType: "guild-text",
			name: "vanished-channel",
			position: 1,
			parentChannelId: null
		},
		{
			guildId: GUILD_ID,
			channelId: THREAD_GONE,
			channelType: "private-thread",
			name: "vanished-thread",
			position: 2,
			parentChannelId: CHANNEL_GONE
		}
	];
	await registries.channelsContract.upsertChannels(channels);

	// One overwrite set naming everything the sweep may have to forget: a role, a member, and the same on the
	// channel that is going away.
	const overwrite = (
		targetId: string,
		targetType: ChannelPermissionOverwrite["targetType"]
	): ChannelPermissionOverwrite => ({
		targetId,
		targetType,
		allowBitfield: VIEW,
		denyBitfield: "0"
	});
	await registries.channelsContract.replaceChannelOverwrites({
		guildId: GUILD_ID,
		channelId: CHANNEL_PRIVATE,
		overwrites: [overwrite(ROLE_OPS, "role"), overwrite(USER_THREE, "member")]
	});
	await registries.channelsContract.replaceChannelOverwrites({
		guildId: GUILD_ID,
		channelId: CHANNEL_GONE,
		overwrites: [overwrite(USER_TWO, "member")]
	});
	await registries.threadMembershipsContract.replaceThreadMemberships({
		guildId: GUILD_ID,
		threadId: THREAD_GONE,
		userIds: [USER_ONE, USER_THREE]
	});
}

/** A roster the provider read to its end: the ids below are the whole roster, so the diff is a departure list. */
function rosterOf(userIds: readonly string[]): VanishedStateReadSets {
	return { roster: { complete: true, userIds } };
}

describe("SweepVanishedStateCommand — the diff rule (R10, R11)", () => {
	it("keeps what the read named and reports only what it stopped naming", () => {
		expect(vanishedFromRead([USER_ONE, USER_TWO, USER_THREE], [USER_TWO])).toEqual([USER_ONE, USER_THREE]);
	});

	it("preserves the stored order, so a sweep is deterministic and a replay is the same list", () => {
		expect(vanishedFromRead(["3", "1", "2"], [])).toEqual(["3", "1", "2"]);
	});

	it("an empty complete read means the whole set is gone — the read is the authority (R10)", () => {
		expect(vanishedFromRead([USER_ONE, USER_TWO], [])).toEqual([USER_ONE, USER_TWO]);
	});

	it("a registry with nothing stored has nothing to vanish, whatever the read said", () => {
		expect(vanishedFromRead([], [USER_ONE, USER_TWO])).toEqual([]);
	});
});

describe("SweepVanishedStateCommand — the memberships that vanished (R11, R4)", () => {
	it("ends the memberships a complete roster no longer reports, with everything that depended on them", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);

		const outcome = await scope.sweep.execute({ guildId: GUILD_ID, reads: rosterOf([USER_ONE]) });

		expect(outcome).toMatchObject({ removedMemberships: 2, removedRoles: 0, removedChannels: 0 });
		// The departed members are gone and the present one is untouched — R4's cascade, scoped to one key.
		expect(scope.registries.memberships.has(USER_TWO)).toBe(false);
		expect(scope.registries.memberships.has(USER_THREE)).toBe(false);
		expect(scope.registries.memberships.get(USER_ONE)?.roleIds).toEqual([ROLE_BACKEND]);
		// R14's revocation-proof half: the overwrite that named a departed member is gone, not inert.
		expect(scope.registries.overwrites.get(CHANNEL_PRIVATE)).toEqual([`role:${ROLE_OPS}`]);
		expect(
			scope.registries.overwrites.get(CHANNEL_PRIVATE)?.some((target) => target === `member:${USER_THREE}`)
		).toBe(false);
		// …and so is their private-thread edge, which is what a re-read cannot resurrect.
		expect(scope.registries.threadMemberships.get(THREAD_GONE)).toEqual([USER_ONE]);
		// The dependent rows are reported as counts, because a sweep that cannot count itself is not provable.
		expect(outcome.dependentRowsRemoved).toBeGreaterThan(0);
		expect(scope.registries.writesOf("deleteMembershipAndDependents")).toHaveLength(2);
	});

	it("never ends a membership the roster still reports, and opens no transaction when nothing vanished", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);
		const writesBefore = scope.registries.writes.length;

		const outcome = await scope.sweep.execute({
			guildId: GUILD_ID,
			reads: {
				...rosterOf([USER_ONE, USER_TWO, USER_THREE]),
				roles: [GUILD_ID, ROLE_BACKEND, ROLE_OPS],
				channels: [CHANNEL_PRIVATE, CHANNEL_GONE, THREAD_GONE]
			}
		});

		expect(outcome.removedMemberships).toBe(0);
		expect(outcome.skipped).toEqual([]);
		expect(scope.registries.memberships.size).toBe(3);
		// A converged registry costs the sweep nothing: not one delete statement (R9).
		expect(scope.registries.writes.slice(writesBefore)).toEqual([]);
	});

	it("refuses to sweep memberships from a truncated roster: a page bound is not a departure list (R2, R11)", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);

		const outcome = await scope.sweep.execute({
			guildId: GUILD_ID,
			reads: {
				// The shape R2's bound produces: this pass saw one member of three, and said so.
				roster: { complete: false, userIds: [USER_ONE] },
				roles: [GUILD_ID, ROLE_BACKEND, ROLE_OPS],
				channels: [CHANNEL_PRIVATE, CHANNEL_GONE, THREAD_GONE]
			}
		});

		expect(outcome.removedMemberships).toBe(0);
		expect(outcome.skipped).toEqual([{ target: "memberships", reason: "roster-truncated" }]);
		expect(scope.registries.writesOf("deleteMembershipAndDependents")).toEqual([]);
		// The mass revocation this rule exists to prevent: the members past the bound keep their rows.
		expect(scope.registries.memberships.has(USER_TWO)).toBe(true);
		expect(scope.registries.memberships.has(USER_THREE)).toBe(true);
		expect(scope.logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			target: "memberships",
			reason: "roster-truncated",
			operation: "sweep-vanished-state"
		});
	});

	it("refuses to sweep a target the pass did not read, rather than concluding absence from silence (R10)", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);
		const writesBefore = scope.registries.writes.length;

		const outcome = await scope.sweep.execute({ guildId: GUILD_ID, reads: {} });

		expect(outcome.skipped).toEqual([
			{ target: "memberships", reason: "not-read-in-this-pass" },
			{ target: "roles", reason: "not-read-in-this-pass" },
			{ target: "channels", reason: "not-read-in-this-pass" }
		]);
		expect(scope.registries.writes.slice(writesBefore)).toEqual([]);
		expect(scope.registries.memberships.size).toBe(3);
	});

	it("issues the cascades in bounded batches, so a long outage cannot open an unbounded transaction (R9)", async () => {
		const scope = sweepHarness({ writeBatchSize: 2 });
		await seed(scope.registries);

		const outcome = await scope.sweep.execute({ guildId: GUILD_ID, reads: rosterOf([]) });

		// Three vanished memberships in groups of two: two bounded groups, three single-row cascades.
		expect(outcome.removedMemberships).toBe(3);
		expect(outcome.batches).toBe(2);
		expect(scope.registries.writesOf("deleteMembershipAndDependents")).toHaveLength(3);
		expect(scope.registries.memberships.size).toBe(0);
	});

	it("is inert over an empty registry, which is why a first bootstrap needs no sweep branch (R9, R11)", async () => {
		const scope = sweepHarness();

		const outcome = await scope.sweep.execute({
			guildId: GUILD_ID,
			reads: { ...rosterOf([USER_ONE]), roles: [GUILD_ID], channels: [CHANNEL_PRIVATE] }
		});

		expect(outcome).toMatchObject({ removedMemberships: 0, removedRoles: 0, removedChannels: 0, batches: 0 });
		expect(outcome.skipped).toEqual([]);
		// Nothing stored, nothing swept: the diff of an empty set is empty by construction, not by a branch.
		expect(scope.registries.writes).toEqual([]);
	});

	it("re-running the same sweep removes nothing the first run did not already remove (R9)", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);

		const first = await scope.sweep.execute({ guildId: GUILD_ID, reads: rosterOf([USER_ONE]) });
		const deletesAfterFirst = scope.registries.writesOf("deleteMembershipAndDependents").length;
		const second = await scope.sweep.execute({ guildId: GUILD_ID, reads: rosterOf([USER_ONE]) });

		expect(first.removedMemberships).toBe(2);
		expect(second.removedMemberships).toBe(0);
		expect(scope.registries.writesOf("deleteMembershipAndDependents")).toHaveLength(deletesAfterFirst);
	});
});

describe("SweepVanishedStateCommand — the roles and channels that vanished (R11, R3, R6)", () => {
	it("routes a role the read no longer names through DeleteRoleCommand, links and overwrites included", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);

		const outcome = await scope.sweep.execute({
			guildId: GUILD_ID,
			reads: { roles: [GUILD_ID, ROLE_BACKEND] }
		});

		expect(outcome).toMatchObject({ removedRoles: 1, removedMemberships: 0, removedChannels: 0 });
		expect(scope.registries.roles.has(ROLE_OPS)).toBe(false);
		// R3's stale-overwrite argument, applied to a swept role: no row hands its permissions to anybody.
		expect(scope.registries.overwrites.get(CHANNEL_PRIVATE)).not.toContain(`role:${ROLE_OPS}`);
		for (const membership of scope.registries.memberships.values()) {
			expect(membership.roleIds).not.toContain(ROLE_OPS);
		}
		expect(scope.registries.writesOf("deleteRoleAndDependents")).toHaveLength(1);
		// The present roles are untouched, @everyone first among them.
		expect(scope.registries.roles.has(GUILD_ID)).toBe(true);
		expect(scope.registries.roles.has(ROLE_BACKEND)).toBe(true);
	});

	it("routes a vanished channel through DeleteChannelCommand and takes its thread with it", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);

		const outcome = await scope.sweep.execute({
			guildId: GUILD_ID,
			reads: { channels: [CHANNEL_PRIVATE] }
		});

		expect(outcome).toMatchObject({ removedChannels: 1 });
		expect(scope.registries.channels.has(CHANNEL_GONE)).toBe(false);
		// R6's cascade: a parent swept during the outage sweeps the thread parented to it too.
		expect(scope.registries.channels.has(THREAD_GONE)).toBe(false);
		expect(scope.registries.overwrites.has(CHANNEL_GONE)).toBe(false);
		expect(scope.registries.threadMemberships.has(THREAD_GONE)).toBe(false);
		expect(scope.registries.writesOf("deleteChannelAndDependents")).toHaveLength(2);
		expect(outcome.dependentRowsRemoved).toBeGreaterThan(0);
	});

	it("sweeps a thread the read dropped without touching its still-present parent", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);

		const outcome = await scope.sweep.execute({
			guildId: GUILD_ID,
			reads: { channels: [CHANNEL_PRIVATE, CHANNEL_GONE] }
		});

		expect(outcome.removedChannels).toBe(1);
		expect(scope.registries.channels.has(THREAD_GONE)).toBe(false);
		expect(scope.registries.channels.has(CHANNEL_GONE)).toBe(true);
	});

	it("treats a complete role read that named nothing as the authority it is (R10)", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);

		const outcome = await scope.sweep.execute({ guildId: GUILD_ID, reads: { roles: [], channels: [] } });

		// An unpaginated read that came back empty is Discord saying the Guild has no roles and no channels.
		// This is the recorded authority rule, not a sweep's own guess: it removes every stored row, which is
		// fail-closed for authorization and is why the read must be complete before anything is diffed.
		expect(outcome.removedRoles).toBe(3);
		expect(scope.registries.roles.size).toBe(0);
		// Three channel rows gone, two counted: the thread went with its parent's cascade, so its own delete
		// reported nothing left to remove. The count is what the registry lost, not how many calls were made.
		expect(outcome.removedChannels).toBe(2);
		expect(scope.registries.channels.size).toBe(0);
		expect(scope.registries.writesOf("deleteChannelAndDependents")).toHaveLength(3);
	});
});

describe("SweepVanishedStateCommand — the boundary and the log (R1, R14)", () => {
	it("given another Guild's read sets, removes nothing and refuses every target", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);
		const writesBefore = scope.registries.writes.length;

		const outcome = await scope.sweep.execute({
			guildId: OTHER_GUILD_ID,
			reads: { ...rosterOf([]), roles: [], channels: [] }
		});

		expect(scope.registries.writes.slice(writesBefore)).toEqual([]);
		expect(scope.registries.memberships.size).toBe(3);
		expect(scope.registries.roles.size).toBe(3);
		expect(outcome.skipped).toEqual([
			{ target: "memberships", reason: "foreign-guild" },
			{ target: "roles", reason: "foreign-guild" },
			{ target: "channels", reason: "foreign-guild" }
		]);
		expect(scope.logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			guildId: GUILD_ID,
			eventGuildId: OTHER_GUILD_ID,
			reason: "foreign-guild",
			operation: "sweep-vanished-state"
		});
	});

	it("logs ids and counts and never a payload (R14)", async () => {
		const scope = sweepHarness();
		await seed(scope.registries);

		await scope.sweep.execute({ guildId: GUILD_ID, reads: rosterOf([USER_ONE]) });

		const transcript = scope.logger.transcript();
		expect(transcript).toContain(USER_TWO);
		expect(transcript).toContain(USER_THREE);
		expect(transcript).toContain("sweep-vanished-state");
		// The swept ids and counts are the whole vocabulary; a role's name is not.
		expect(transcript).not.toMatch(/"(roleName|nickname|username|content|token|permissionsBitfield)":/);
		expect(transcript).not.toContain("vanished-channel");
		for (const line of scope.logger.linesAt("info")) {
			expect(Object.keys(line.fields).sort()).toEqual(
				[
					"batches",
					"dependentRowsRemoved",
					"guildId",
					"operation",
					"removedCount",
					"removedIds",
					"target"
				].sort()
			);
		}
	});
});
