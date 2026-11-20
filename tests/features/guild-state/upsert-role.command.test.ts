import { describe, expect, it } from "vitest";
import { UpsertRoleCommand } from "../../../src/features/guild-state/commands/upsert-role.command.js";
import type { UpsertRoleEvent } from "../../../src/features/guild-state/commands/upsert-role.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { InvalidPermissionBitfieldError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import type { PermissionBitfield } from "../../../src/features/guild-state/models/domain/permission-bitfield.js";
import type { RegistryRole } from "../../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T3 — role registry event application (docs/features/guild-state.md R3, R9, R10, and R1 at the event
 * boundary).
 *
 * The doubles behind the repository contract apply the same natural-key rules as the PostgreSQL adapters
 * (replace on the id, bounded to one call per write), so what these cases prove is the *command's* decisions:
 * which row ends up stored for one role event, which fields a payload may leave to the registry, and when the
 * command must refuse rather than invent role data (R3's error case). The SQL, the cascade and the one
 * transaction per write are proven against a real database in
 * `tests/integration/guild-state-event-application.integration.test.ts`.
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const CHANNEL_PRIVATE = "160000000000000201";
const VIEW_CHANNEL = "1024";
const READ_MESSAGE_HISTORY = "65536";
/** Beyond `Number.MAX_SAFE_INTEGER`: the text survives only if nothing coerces it (R3). */
const UNSAFE_BITFIELD = "9007199254740993";

interface Harness {
	readonly command: UpsertRoleCommand;
	readonly registries: RecordingRegistries;
	readonly logger: RecordingLogger;
}

function harness(registries = new RecordingRegistries()): Harness {
	const logger = new RecordingLogger();
	const command = new UpsertRoleCommand({
		config: createGuildStateConfig({ guildId: GUILD_ID }),
		roleRegistry: registries.rolesContract,
		logger
	});
	return { command, registries, logger };
}

/** A complete `GUILD_ROLE_CREATE`/`GUILD_ROLE_UPDATE`-shaped payload, as the subscription binding hands it. */
function payload(overrides: Partial<UpsertRoleEvent> = {}): UpsertRoleEvent {
	return {
		guildId: GUILD_ID,
		roleId: ROLE_BACKEND,
		roleName: "backend",
		permissionsBitfield: VIEW_CHANNEL,
		position: 1,
		...overrides
	};
}

async function seed(registries: RecordingRegistries, role: RegistryRole): Promise<void> {
	await registries.rolesContract.upsertRoles([role]);
}

describe("UpsertRoleCommand (R3, R9, R10)", () => {
	it("stores a role event for an id the registry has never seen as a new role (R10 convergence)", async () => {
		const { command, registries } = harness();

		const outcome = await command.execute(payload());

		expect(outcome).toMatchObject({ status: "applied", created: true, rowsWritten: 1 });
		expect(registries.roles.get(ROLE_BACKEND)).toEqual({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: "backend",
			permissionsBitfield: VIEW_CHANNEL,
			position: 1
		});
		// One role event is one write of one row: no read-modify-write round trip, no second statement.
		expect(registries.writesOf("upsertRoles")).toHaveLength(1);
	});

	it("replaces the stored role wholesale, so no bitfield from the previous state survives (R3, R10)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);
		await seed(registries, {
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: "old-name",
			permissionsBitfield: VIEW_CHANNEL,
			position: 7
		});

		await command.execute(payload({ roleName: "renamed", permissionsBitfield: READ_MESSAGE_HISTORY, position: 2 }));

		// Not `1024 | 65536`: the union is evaluation's job (R3's example), never the write path's.
		expect(registries.roles.get(ROLE_BACKEND)).toEqual({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: "renamed",
			permissionsBitfield: READ_MESSAGE_HISTORY,
			position: 2
		});
	});

	it("keeps a bitfield beyond the safe-integer range exactly as Discord encoded it (R3)", async () => {
		const { command, registries } = harness();

		await command.execute(payload({ permissionsBitfield: UNSAFE_BITFIELD }));

		expect(registries.roles.get(ROLE_BACKEND)?.permissionsBitfield).toBe(UNSAFE_BITFIELD);
	});

	it("completes a field the payload did not carry from the stored row instead of blanking it (R10)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);
		await seed(registries, {
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: "backend",
			permissionsBitfield: VIEW_CHANNEL,
			position: 4
		});

		// An update that carried only the new bitfield: no name, no position in the payload at all.
		const outcome = await command.execute({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			permissionsBitfield: READ_MESSAGE_HISTORY
		});

		expect(outcome).toMatchObject({ status: "applied", created: false });
		expect(registries.roles.get(ROLE_BACKEND)).toEqual({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			// Carried over from the row the registry already holds, not invented here.
			roleName: "backend",
			permissionsBitfield: READ_MESSAGE_HISTORY,
			position: 4
		});
	});

	it("refuses to create a role from an incomplete description and writes nothing (R3 error case, R11)", async () => {
		const { command, registries, logger } = harness();

		const outcome = await command.execute({ guildId: GUILD_ID, roleId: ROLE_BACKEND, position: 3 });

		expect(outcome).toMatchObject({
			status: "refused",
			reason: "incomplete-role-description",
			missingFields: ["roleName", "permissionsBitfield"]
		});
		expect(registries.roles.size).toBe(0);
		expect(registries.writes).toEqual([]);
		// The anomaly is reported for the R11 targeted read, and it names ids and fields only.
		expect(logger.linesAt("warn")).toHaveLength(1);
		expect(logger.transcript()).toContain(ROLE_BACKEND);
	});

	it("leaves identical state when the same role event is applied twice (R9 idempotency)", async () => {
		const { command, registries } = harness();

		const first = await command.execute(payload());
		const before = registries.state();
		const second = await command.execute(payload());

		expect(first).toMatchObject({ status: "applied", created: true });
		expect(second).toMatchObject({ status: "applied", created: false });
		expect(registries.state()).toEqual(before);
		expect(registries.roles.size).toBe(1);
	});

	it("stores @everyone like any other role, leaving the folding rule to evaluation (R3 boundary)", async () => {
		const { command, registries } = harness();

		await command.execute(payload({ roleId: GUILD_ID, roleName: "@everyone", permissionsBitfield: "0" }));

		// The role id of @everyone is the Guild id, and it is stored under that id like any role row.
		expect(registries.roles.get(GUILD_ID)).toMatchObject({ roleId: GUILD_ID, permissionsBitfield: "0" });
	});

	it("drops a role event that names another Guild, writing nothing (R1)", async () => {
		const { command, registries, logger } = harness();

		const outcome = await command.execute(payload({ guildId: OTHER_GUILD_ID }));

		expect(outcome).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(registries.writes).toEqual([]);
		expect(registries.roles.size).toBe(0);
		// R14's boundary: a foreign event is logged with its Guild id and the resource id, nothing else.
		const warn = logger.linesAt("warn")[0];
		expect(JSON.stringify(warn?.fields)).toContain(OTHER_GUILD_ID);
		expect(JSON.stringify(warn?.fields)).not.toContain("backend");
	});

	it("refuses a bitfield that arrived as a number instead of storing a coerced grant (R3)", async () => {
		const { command, registries } = harness();

		const coerced = payload({ permissionsBitfield: Number(VIEW_CHANNEL) as unknown as PermissionBitfield });

		await expect(command.execute(coerced)).rejects.toBeInstanceOf(InvalidPermissionBitfieldError);
		expect(registries.writes).toEqual([]);
	});

	it("refuses a position that is not a whole number instead of rounding it into the row (R3)", async () => {
		const { command, registries } = harness();

		await expect(command.execute(payload({ position: 1.5 }))).rejects.toThrow(/role_position/);
		expect(registries.writes).toEqual([]);
	});

	it("refuses a role id that cannot live in a bigint column (R9 natural keys)", async () => {
		const { command, registries } = harness();

		await expect(command.execute(payload({ roleId: "role-name" }))).rejects.toThrow(/guild_role\.role_id/);
		expect(registries.writes).toEqual([]);
	});

	it("logs ids and counts only — never the role name or its bitfield (R14)", async () => {
		const { command, logger } = harness();

		await command.execute(payload({ roleName: "peekaboo", permissionsBitfield: UNSAFE_BITFIELD }));

		const transcript = logger.transcript();
		expect(transcript).toContain(GUILD_ID);
		expect(transcript).toContain(ROLE_BACKEND);
		expect(transcript).not.toContain("peekaboo");
		expect(transcript).not.toContain(UNSAFE_BITFIELD);
	});

	it("does not touch memberships or overwrites: creation is a role row and nothing else (R5)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);
		await registries.membershipsContract.upsertMemberships([
			{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] }
		]);
		await registries.channelsContract.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});
		const before = registries.state();

		await command.execute(payload({ permissionsBitfield: READ_MESSAGE_HISTORY }));

		expect(registries.state().memberships).toEqual(before.memberships);
		expect(registries.state().overwrites).toEqual(before.overwrites);
	});
});
