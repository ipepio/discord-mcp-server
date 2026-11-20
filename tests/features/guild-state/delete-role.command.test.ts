import { describe, expect, it } from "vitest";
import { DeleteRoleCommand } from "../../../src/features/guild-state/commands/delete-role.command.js";
import type { DeleteRoleEvent } from "../../../src/features/guild-state/commands/delete-role.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type {
	RegistryChannelOverwriteSet,
	RegistryRole
} from "../../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T3 — role deletion and its cascade (docs/features/guild-state.md R3, R9, R14).
 *
 * The cascade itself is the T1 repository's statement sequence — role-membership rows, then the
 * role-targeted overwrites, then the role row, in one transaction, each step `RETURNING` so the counts are the
 * database's answer. What this command owns, and what these cases pin, is that one `GUILD_ROLE_DELETE` is
 * exactly one repository call (never a read-modify-write loop), that a replayed or unknown deletion is a
 * counted no-op rather than an error, and that the log line carries the ids and counts R14 names.
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const ROLE_BACKEND = "160000000000000010";
const ROLE_OPS = "160000000000000011";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const CHANNEL_PRIVATE = "160000000000000201";
const VIEW_CHANNEL = "1024";

interface Harness {
	readonly command: DeleteRoleCommand;
	readonly registries: RecordingRegistries;
	readonly logger: RecordingLogger;
}

function harness(registries = new RecordingRegistries()): Harness {
	const logger = new RecordingLogger();
	const command = new DeleteRoleCommand({
		config: createGuildStateConfig({ guildId: GUILD_ID }),
		roleRegistry: registries.rolesContract,
		logger
	});
	return { command, registries, logger };
}

function role(roleId: string, bitfield = VIEW_CHANNEL, position = 1): RegistryRole {
	return { guildId: GUILD_ID, roleId, roleName: `role-${roleId}`, permissionsBitfield: bitfield, position };
}

function overwrites(channelId: string, targets: readonly string[]): RegistryChannelOverwriteSet {
	return {
		guildId: GUILD_ID,
		channelId,
		overwrites: targets.map((targetId) => ({
			targetId,
			targetType: "role" as const,
			allowBitfield: VIEW_CHANNEL,
			denyBitfield: "0"
		}))
	};
}

/** One Guild, two roles, two members (one holding both), one channel carrying two role overwrites. */
async function seededRegistries(): Promise<RecordingRegistries> {
	const registries = new RecordingRegistries();
	await registries.rolesContract.upsertRoles([role(GUILD_ID, "0", 0), role(ROLE_BACKEND), role(ROLE_OPS, "0", 2)]);
	await registries.channelsContract.upsertChannels([
		{
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private",
			position: 0,
			parentChannelId: null
		}
	]);
	await registries.membershipsContract.upsertMemberships([
		{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND, ROLE_OPS] },
		{ guildId: GUILD_ID, userId: USER_TWO, roleIds: [ROLE_BACKEND] }
	]);
	await registries.channelsContract.replaceChannelOverwrites(overwrites(CHANNEL_PRIVATE, [ROLE_BACKEND, ROLE_OPS]));
	// The seed is fixture state, not evidence: what these cases assert is the write log of the command.
	registries.writes.splice(0, registries.writes.length);
	return registries;
}

const deletion: DeleteRoleEvent = { guildId: GUILD_ID, roleId: ROLE_BACKEND };

describe("DeleteRoleCommand (R3, R9, R14)", () => {
	it("deletes the role through the repository cascade, in one call and one transaction (R3)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await command.execute(deletion);

		// One repository operation is the whole cascade; the adapter wraps its three statements in one transaction.
		expect(registries.writesOf("deleteRoleAndDependents")).toHaveLength(1);
		expect(registries.operationOrder()).toEqual(["deleteRoleAndDependents"]);
	});

	it("removes the role row, every assignment of it and every overwrite targeting it (R3)", async () => {
		const { command, registries } = harness(await seededRegistries());

		const outcome = await command.execute(deletion);

		expect(outcome).toMatchObject({
			status: "applied",
			roleId: ROLE_BACKEND,
			roleRemoved: true,
			membershipLinksRemoved: 2,
			overwritesRemoved: 1
		});
		expect(registries.roles.has(ROLE_BACKEND)).toBe(false);
		expect(registries.memberships.get(USER_ONE)?.roleIds).toEqual([ROLE_OPS]);
		expect(registries.memberships.get(USER_TWO)?.roleIds).toEqual([]);
		expect(registries.overwrites.get(CHANNEL_PRIVATE)).toEqual([`role:${ROLE_OPS}`]);
	});

	it("leaves every other role, member and channel untouched (R3, R5's 'nothing else changes')", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		const before = registries.state();

		await command.execute(deletion);

		expect(registries.state().guild).toEqual(before.guild);
		expect(registries.state().memberships.map((entry) => entry.userId)).toEqual(
			before.memberships.map((entry) => entry.userId)
		);
		expect(registries.state().channels).toEqual(before.channels);
		// The other role is still stored with its own bitfield, and still assigned where it was.
		expect(registries.roles.get(ROLE_OPS)).toEqual(before.roles.find((entry) => entry.roleId === ROLE_OPS));
	});

	it("counts a deletion of an unknown role id as a no-op and does not fail (R9 replay)", async () => {
		const { command, registries, logger } = harness(await seededRegistries());

		const outcome = await command.execute({ guildId: GUILD_ID, roleId: "160000000000000012" });

		expect(outcome).toMatchObject({
			status: "applied",
			roleRemoved: false,
			membershipLinksRemoved: 0,
			overwritesRemoved: 0
		});
		expect(registries.roles.size).toBe(3);
		expect(logger.linesAt("error")).toEqual([]);
	});

	it("leaves identical state when the same role deletion is applied twice (R9)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await command.execute(deletion);
		const afterFirst = registries.state();
		const second = await command.execute(deletion);

		expect(second).toMatchObject({ status: "applied", roleRemoved: false });
		expect(registries.state()).toEqual(afterFirst);
	});

	it("drops a deletion that names another Guild without touching this registry (R1)", async () => {
		const { command, registries, logger } = harness(await seededRegistries());

		const outcome = await command.execute({ guildId: OTHER_GUILD_ID, roleId: ROLE_BACKEND });

		expect(outcome).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(registries.writes).toEqual([]);
		expect(registries.roles.has(ROLE_BACKEND)).toBe(true);
		expect(logger.linesAt("warn").map((line) => line.fields)).toEqual([
			{ guildId: GUILD_ID, eventGuildId: OTHER_GUILD_ID, roleId: ROLE_BACKEND, operation: "delete-role" }
		]);
	});

	it("refuses a role id that cannot live in a bigint column (R9 natural keys)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await expect(command.execute({ guildId: GUILD_ID, roleId: "everyone" })).rejects.toThrow(/guild_role\.role_id/);
		expect(registries.writes).toEqual([]);
	});

	it("logs the guild id, role id and the removed counts, and nothing else (R14, R3's example)", async () => {
		const { command, logger } = harness(await seededRegistries());

		await command.execute(deletion);

		const line = logger.linesAt("info").at(-1);
		expect(line?.fields).toMatchObject({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			roleRemoved: true,
			membershipLinksRemoved: 2,
			overwritesRemoved: 1
		});
		expect(JSON.stringify(line?.fields)).not.toContain("role-160000000000000010");
		expect(JSON.stringify(line?.fields)).not.toContain(VIEW_CHANNEL);
	});
});
