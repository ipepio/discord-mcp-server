import { describe, expect, it } from "vitest";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { EndMembershipCommand } from "../../../src/features/guild-state/commands/end-membership.command.js";
import type { EndMembershipEvent } from "../../../src/features/guild-state/commands/end-membership.command.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T4 — a Membership ending (docs/features/guild-state.md R4, R9, R14).
 *
 * Leave, kick and ban are one operation here: none of the three is a different stored state, and all three end
 * the Membership now. What the command promises is that one member event produces exactly one repository call,
 * because that call is the single transaction the schema writes — Membership row, role assignments,
 * private-thread edges and the overwrites that targeted the member (the security-favoring sweep pinned in
 * `odd/tasks/guild-state.md` L3(2), which R4's text does not name but the T1 cascade performs).
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const USER_GONE = "160000000000000104";
const CHANNEL_PRIVATE = "160000000000000201";
const THREAD_UNDER_PRIVATE = "160000000000000203";
const VIEW_CHANNEL = "1024";

interface Harness {
	readonly command: EndMembershipCommand;
	readonly registries: RecordingRegistries;
	readonly logger: RecordingLogger;
}

function harness(registries = new RecordingRegistries()): Harness {
	const logger = new RecordingLogger();
	const command = new EndMembershipCommand({
		config: createGuildStateConfig({ guildId: GUILD_ID }),
		membershipRegistry: registries.membershipsContract,
		logger
	});
	return { command, registries, logger };
}

/** A member with a role, a thread edge and a member-targeted overwrite, plus an untouched second member. */
async function seededRegistries(): Promise<RecordingRegistries> {
	const registries = new RecordingRegistries();
	await registries.rolesContract.upsertRoles([
		{ guildId: GUILD_ID, roleId: GUILD_ID, roleName: "@everyone", permissionsBitfield: "0", position: 0 },
		{ guildId: GUILD_ID, roleId: ROLE_BACKEND, roleName: "backend", permissionsBitfield: VIEW_CHANNEL, position: 1 }
	]);
	await registries.channelsContract.upsertChannels([
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
			channelId: THREAD_UNDER_PRIVATE,
			channelType: "private-thread",
			name: "incident",
			position: 0,
			parentChannelId: CHANNEL_PRIVATE
		}
	]);
	await registries.membershipsContract.upsertMemberships([
		{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] },
		{ guildId: GUILD_ID, userId: USER_TWO, roleIds: [ROLE_BACKEND] }
	]);
	await registries.threadMembershipsContract.replaceThreadMemberships({
		guildId: GUILD_ID,
		threadId: THREAD_UNDER_PRIVATE,
		userIds: [USER_ONE, USER_TWO]
	});
	await registries.channelsContract.replaceChannelOverwrites({
		guildId: GUILD_ID,
		channelId: CHANNEL_PRIVATE,
		overwrites: [
			{ targetId: USER_ONE, targetType: "member", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
			{ targetId: USER_TWO, targetType: "member", allowBitfield: "0", denyBitfield: "0" },
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
		]
	});
	registries.writes.splice(0, registries.writes.length);
	return registries;
}

const removal: EndMembershipEvent = { guildId: GUILD_ID, userId: USER_ONE };

describe("EndMembershipCommand (R4, R9, R14)", () => {
	it("ends the membership through exactly one repository call, i.e. one transaction (R4)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await command.execute(removal);

		expect(registries.operationOrder()).toEqual(["deleteMembershipAndDependents"]);
	});

	it("removes the membership, its role set, its thread edge and its member overwrites together (R4, L3)", async () => {
		const { command, registries } = harness(await seededRegistries());

		const outcome = await command.execute(removal);

		expect(outcome).toMatchObject({
			status: "applied",
			userId: USER_ONE,
			membershipRemoved: true,
			roleLinksRemoved: 1,
			overwritesRemoved: 1,
			threadMembershipsRemoved: 1
		});
		expect(registries.memberships.has(USER_ONE)).toBe(false);
		expect(registries.threadMemberships.get(THREAD_UNDER_PRIVATE)).toEqual([USER_TWO]);
		// Only this member's overwrite went: the other member's and the role's both survive.
		expect(registries.overwrites.get(CHANNEL_PRIVATE)).toEqual([`member:${USER_TWO}`, `role:${ROLE_BACKEND}`]);
	});

	it("leaves every other member, role and channel row untouched (R4)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		const before = registries.state();

		await command.execute(removal);

		expect(registries.state().guild).toEqual(before.guild);
		expect(registries.state().roles).toEqual(before.roles);
		expect(registries.state().channels).toEqual(before.channels);
		expect(registries.state().memberships.map((entry) => entry.userId)).toEqual([USER_TWO]);
	});

	it("treats a removal for an id with no membership as a counted no-op, not an error (R4's error case)", async () => {
		const { command, registries, logger } = harness(await seededRegistries());

		const outcome = await command.execute({ guildId: GUILD_ID, userId: USER_GONE });

		expect(outcome).toMatchObject({
			status: "applied",
			userId: USER_GONE,
			membershipRemoved: false,
			roleLinksRemoved: 0,
			overwritesRemoved: 0,
			threadMembershipsRemoved: 0
		});
		expect(logger.linesAt("error")).toEqual([]);
		expect(registries.memberships.size).toBe(2);
	});

	it("leaves identical state when the same removal is applied twice (R9)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await command.execute(removal);
		const afterFirst = registries.state();
		const second = await command.execute(removal);

		expect(second).toMatchObject({ status: "applied", membershipRemoved: false });
		expect(registries.state()).toEqual(afterFirst);
	});

	it("is the same operation for a leave, a kick or a ban — the distinction never reaches the write (R4)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		const ended = await command.execute(removal);

		expect(ended).toMatchObject({ status: "applied", membershipRemoved: true });
		expect(registries.memberships.has(USER_ONE)).toBe(false);
		// The input has no field for leave vs kick vs ban, so the command cannot branch on a fact it never
		// receives: all three member-removal kinds are the same stored outcome (R4's boundary, open decision O3).
		expect(Object.keys(removal).sort()).toEqual(["guildId", "userId"]);
	});

	it("drops a removal that names another Guild without touching this registry (R1)", async () => {
		const { command, registries, logger } = harness(await seededRegistries());

		const outcome = await command.execute({ guildId: OTHER_GUILD_ID, userId: USER_ONE });

		expect(outcome).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(registries.writes).toEqual([]);
		expect(registries.memberships.has(USER_ONE)).toBe(true);
		expect(logger.linesAt("warn").map((line) => line.fields)).toEqual([
			{ guildId: GUILD_ID, eventGuildId: OTHER_GUILD_ID, userId: USER_ONE, operation: "end-membership" }
		]);
	});

	it("refuses an id that cannot live in a bigint column (R9 natural keys)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await expect(command.execute({ guildId: GUILD_ID, userId: "nobody" })).rejects.toThrow(
			/guild_membership\.user_id/
		);
		expect(registries.writes).toEqual([]);
	});

	it("logs the guild id, user id and the cascade counts, and nothing else (R14)", async () => {
		const { command, logger } = harness(await seededRegistries());

		await command.execute(removal);

		const line = logger.linesAt("info").at(-1);
		expect(line?.fields).toMatchObject({
			guildId: GUILD_ID,
			userId: USER_ONE,
			membershipRemoved: true,
			roleLinksRemoved: 1,
			overwritesRemoved: 1,
			threadMembershipsRemoved: 1
		});
		expect(JSON.stringify(line?.fields)).not.toContain("backend");
	});
});
