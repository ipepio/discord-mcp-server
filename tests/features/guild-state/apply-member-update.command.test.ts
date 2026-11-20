import { describe, expect, it } from "vitest";
import { ApplyMemberUpdateCommand } from "../../../src/features/guild-state/commands/apply-member-update.command.js";
import type {
	ApplyMemberUpdateCommandDeps,
	ApplyMemberUpdateEvent
} from "../../../src/features/guild-state/commands/apply-member-update.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { RegistryRole } from "../../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T4 — join and member updates: the Membership row and its COMPLETE role set
 * (docs/features/guild-state.md R4, R5, R9, R10, plus R1 at the event boundary).
 *
 * R5 is the whole design: Discord's member payload carries the entire `roles` array, so the stored set is
 * replaced and never merged. The one thing the registry may not do is hand the foreign key a role id it has
 * never seen — `guild_membership_role` references `guild_role`, so an unknown id is reported as deferred and
 * the set that converges later is the one the FK allows (the pinned tension in `odd/tasks/guild-state.md` L3).
 * The doubles apply the same replacement semantics as the PostgreSQL adapter; the SQL is proven in
 * `tests/integration/guild-state-event-application.integration.test.ts`.
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const ROLE_BACKEND = "160000000000000010";
const ROLE_OPS = "160000000000000011";
const ROLE_UNKNOWN = "160000000000000012";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const USER_BOT = "160000000000000103";
const CHANNEL_PRIVATE = "160000000000000201";
const VIEW_CHANNEL = "1024";

interface Harness {
	readonly command: ApplyMemberUpdateCommand;
	readonly registries: RecordingRegistries;
	readonly logger: RecordingLogger;
}

function harness(registries = new RecordingRegistries()): Harness {
	const logger = new RecordingLogger();
	const deps: ApplyMemberUpdateCommandDeps = {
		config: createGuildStateConfig({ guildId: GUILD_ID }),
		roleRegistry: registries.rolesContract,
		membershipRegistry: registries.membershipsContract,
		logger
	};
	return { command: new ApplyMemberUpdateCommand(deps), registries, logger };
}

function role(roleId: string, position = 1): RegistryRole {
	return { guildId: GUILD_ID, roleId, roleName: `role-${roleId}`, permissionsBitfield: VIEW_CHANNEL, position };
}

/** The roles and the other member a member event is applied against, with the write log cleared afterwards. */
async function seededRegistries(): Promise<RecordingRegistries> {
	const registries = new RecordingRegistries();
	await registries.rolesContract.upsertRoles([role(GUILD_ID, 0), role(ROLE_BACKEND), role(ROLE_OPS, 2)]);
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
		{ guildId: GUILD_ID, userId: USER_TWO, roleIds: [ROLE_OPS] }
	]);
	await registries.channelsContract.replaceChannelOverwrites({
		guildId: GUILD_ID,
		channelId: CHANNEL_PRIVATE,
		overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
	});
	registries.writes.splice(0, registries.writes.length);
	return registries;
}

function update(userId: string, roleIds: readonly string[]): ApplyMemberUpdateEvent {
	return { guildId: GUILD_ID, userId, roleIds };
}

describe("ApplyMemberUpdateCommand (R4, R5, R9, R10)", () => {
	it("creates the membership on a join, with the role set the payload carried (R4)", async () => {
		const { command, registries } = harness(await seededRegistries());

		const outcome = await command.execute(update(USER_ONE, [ROLE_BACKEND]));

		expect(outcome).toMatchObject({
			status: "applied",
			userId: USER_ONE,
			roleIdsStored: [ROLE_BACKEND],
			deferredRoleIds: []
		});
		expect(registries.memberships.get(USER_ONE)).toEqual({
			guildId: GUILD_ID,
			userId: USER_ONE,
			roleIds: [ROLE_BACKEND]
		});
	});

	it("replaces the whole set: a role the payload dropped is gone, not kept (R5)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		await command.execute(update(USER_ONE, [ROLE_BACKEND, ROLE_OPS]));

		const outcome = await command.execute(update(USER_ONE, [ROLE_BACKEND]));

		expect(outcome).toMatchObject({ roleIdsStored: [ROLE_BACKEND] });
		expect(registries.memberships.get(USER_ONE)?.roleIds).toEqual([ROLE_BACKEND]);
	});

	it("stores an explicitly empty role set and keeps the member a member (R5's boundary)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		await command.execute(update(USER_ONE, [ROLE_BACKEND]));

		await command.execute(update(USER_ONE, []));

		const roleless = await registries.membershipsContract.findMembership(GUILD_ID, USER_ONE);
		expect(roleless?.roleIds).toEqual([]);
		// The state R5 says is different: no membership row at all, not a member holding nothing.
		expect(await registries.membershipsContract.findMembership(GUILD_ID, USER_BOT)).toBeNull();
	});

	it("writes the identity row and the whole set in one repository call, so it is one transaction (R5)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await command.execute(update(USER_ONE, [ROLE_BACKEND, ROLE_OPS]));

		expect(registries.operationOrder()).toEqual(["upsertMemberships"]);
	});

	it("leaves role definitions, overwrites and other members untouched (R5)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		const before = registries.state();

		await command.execute(update(USER_ONE, [ROLE_BACKEND]));

		expect(registries.state().roles).toEqual(before.roles);
		expect(registries.state().overwrites).toEqual(before.overwrites);
		expect(registries.state().memberships.find((entry) => entry.userId === USER_TWO)?.roleIds).toEqual([ROLE_OPS]);
	});

	it("stores only what the foreign key allows and reports the unknown role id as deferred (R5 error case, L3)", async () => {
		const { command, registries, logger } = harness(await seededRegistries());

		const outcome = await command.execute(update(USER_ONE, [ROLE_BACKEND, ROLE_UNKNOWN]));

		expect(outcome).toMatchObject({
			status: "applied",
			roleIdsStored: [ROLE_BACKEND],
			deferredRoleIds: [ROLE_UNKNOWN]
		});
		expect(registries.memberships.get(USER_ONE)?.roleIds).toEqual([ROLE_BACKEND]);
		// The deferral is an anomaly to report, so it is visible at warn level with its id (R14).
		expect(logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			userId: USER_ONE,
			deferredRoleIds: [ROLE_UNKNOWN]
		});
	});

	it("converges the deferred role when a later member event carries it, after the role arrives (R10)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		await command.execute(update(USER_ONE, [ROLE_BACKEND, ROLE_UNKNOWN]));

		// The role definition arrives (T3's own path), and the same complete set is applied again.
		await registries.rolesContract.upsertRoles([role(ROLE_UNKNOWN, 3)]);
		const converged = await command.execute(update(USER_ONE, [ROLE_BACKEND, ROLE_UNKNOWN]));

		expect(converged).toMatchObject({ roleIdsStored: [ROLE_BACKEND, ROLE_UNKNOWN], deferredRoleIds: [] });
		expect(registries.memberships.get(USER_ONE)?.roleIds).toEqual([ROLE_BACKEND, ROLE_UNKNOWN]);
	});

	it("changes nothing observable when the same member event is applied twice (R9)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await command.execute(update(USER_ONE, [ROLE_BACKEND, ROLE_OPS]));
		const afterFirst = registries.state();
		await command.execute(update(USER_ONE, [ROLE_BACKEND, ROLE_OPS]));

		expect(registries.state()).toEqual(afterFirst);
		expect(registries.memberships.size).toBe(2);
	});

	it("stores a bot or webhook member exactly like any other member (R4's boundary)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		await command.execute(update(USER_BOT, [ROLE_BACKEND]));

		// Nothing but the natural key and the role set reaches the row: no display data, no bot flag (O2, R14).
		expect(registries.memberships.get(USER_BOT)).toEqual({
			guildId: GUILD_ID,
			userId: USER_BOT,
			roleIds: [ROLE_BACKEND]
		});
	});

	it("stores @everyone when a payload names it, because dropping it would be inferring state (R3)", async () => {
		const { command, registries } = harness(await seededRegistries());

		const outcome = await command.execute(update(USER_ONE, [GUILD_ID, ROLE_BACKEND]));

		expect(outcome).toMatchObject({ deferredRoleIds: [] });
		expect(registries.memberships.get(USER_ONE)?.roleIds).toEqual([GUILD_ID, ROLE_BACKEND]);
	});

	it("drops a member event that names another Guild, writing nothing (R1)", async () => {
		const { command, registries, logger } = harness(await seededRegistries());

		const outcome = await command.execute({ guildId: OTHER_GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] });

		expect(outcome).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(registries.writes).toEqual([]);
		expect(registries.memberships.has(USER_ONE)).toBe(false);
		expect(logger.linesAt("warn").map((line) => line.fields)).toEqual([
			{
				guildId: GUILD_ID,
				eventGuildId: OTHER_GUILD_ID,
				userId: USER_ONE,
				operation: "apply-member-update"
			}
		]);
	});

	it("refuses ids that cannot live in a bigint column instead of storing a coerced one (R9)", async () => {
		const { command, registries } = harness(await seededRegistries());

		await expect(command.execute(update("some-user", [ROLE_BACKEND]))).rejects.toThrow(/guild_membership\.user_id/);
		await expect(command.execute(update(USER_ONE, ["not-a-role"]))).rejects.toThrow(
			/guild_membership_role\.role_id/
		);
		expect(registries.writes).toEqual([]);
	});

	it("logs ids and counts only (R14)", async () => {
		const { command, logger } = harness(await seededRegistries());

		await command.execute(update(USER_ONE, [ROLE_BACKEND]));

		const line = logger.linesAt("info").at(-1);
		expect(line?.fields).toMatchObject({ guildId: GUILD_ID, userId: USER_ONE, roleCount: 1, deferredRoleCount: 0 });
		expect(JSON.stringify(line?.fields)).not.toContain("role-160000000000000010");
	});
});
