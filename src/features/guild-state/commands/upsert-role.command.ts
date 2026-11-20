import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { completeRoleDescription } from "../models/domain/event-application-rules.js";
import type { RoleDescriptionOutcome } from "../models/domain/event-application-rules.js";
import { InvalidRegistryFieldValueError } from "../models/domain/guild-state-registry.errors.js";
import { isForeignGuildRecord } from "../models/domain/registry-rules.js";
import type { RoleRegistryRepository } from "../repositories/role-registry.repository.js";

/**
 * One role event applied to the registry (docs/features/guild-state.md R3, R9, R10; R1 at the event boundary).
 *
 * The application input mirrors what a `GUILD_ROLE_CREATE`/`GUILD_ROLE_UPDATE` payload says about one role, with
 * the fields the payload may omit left genuinely absent (no discord.js type reaches this seam, so the
 * subscription binding is a field-for-field map). Everything the write path is responsible for follows from two
 * rules:
 *
 * - **R3, replacement.** The role is written as one whole row through the repository's idempotent upsert. Nothing
 *   here reads the previous bitfield to combine it with the new one: permission arithmetic belongs to evaluation
 *   (R13), and R10 forbids a merged or partial overwrite. `@everyone` is stored like any other role — folding it
 *   into a member's base is the evaluation query's rule, not this one.
 * - **R10, convergence.** A role event naming an id the registry has never seen becomes a new role row, which is
 *   exactly what the upsert does on a natural-key miss. A field the event did not carry is completed from the row
 *   already stored, and a field with no source at all refuses the write rather than inventing role data.
 *
 * R9: the same event applied twice writes the same row twice, so the state after the second delivery is
 * indistinguishable from the state after the first.
 */

/** One role as a normalized role event describes it. Absent fields were absent from the payload. */
export interface UpsertRoleEvent {
	/** The Guild the event came from. Anything other than the configured one is dropped (R1). */
	readonly guildId: DiscordIdentifier;
	readonly roleId: DiscordIdentifier;
	readonly roleName?: string;
	readonly permissionsBitfield?: string;
	readonly position?: number;
}

/** Where one role event ended up. Every case is reported, because a refusal is an anomaly, not a success. */
export type UpsertRoleOutcome =
	| {
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly roleId: DiscordIdentifier;
			/** True when the registry held no row for this role id before this event. */
			readonly created: boolean;
			readonly rowsWritten: number;
			readonly completedFields: readonly string[];
	  }
	| {
			readonly status: "refused";
			readonly guildId: DiscordIdentifier;
			readonly roleId: DiscordIdentifier;
			readonly reason: "incomplete-role-description";
			readonly missingFields: readonly string[];
	  }
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly roleId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface UpsertRoleCommandDeps {
	readonly config: GuildStateConfig;
	readonly roleRegistry: RoleRegistryRepository;
	readonly logger: AppLogger;
}

export class UpsertRoleCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly roleRegistry: RoleRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: UpsertRoleCommandDeps) {
		this.guildId = deps.config.guildId;
		this.roleRegistry = deps.roleRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (event: UpsertRoleEvent): Promise<UpsertRoleOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			return this.dropForeignGuild(event.guildId, event.roleId);
		}

		const roleId = requireDiscordIdentifier("guild_role.role_id", event.roleId);
		this.requireStorablePosition(event.position);

		// The one read of the row this event describes: it exists to complete what the payload omitted, never to
		// combine two bitfields. Bounded by Discord's own per-Guild role ceiling, like the projection itself.
		const stored = (await this.roleRegistry.findRoles(this.guildId)).find((role) => role.roleId === roleId) ?? null;
		const description = completeRoleDescription(
			this.guildId,
			{
				roleId,
				...(event.roleName === undefined ? {} : { roleName: event.roleName }),
				...(event.permissionsBitfield === undefined ? {} : { permissionsBitfield: event.permissionsBitfield }),
				...(event.position === undefined ? {} : { position: event.position })
			},
			stored
		);

		if (description.status === "refused") {
			return this.refuse(roleId, description);
		}

		const written = await this.roleRegistry.upsertRoles([description.role]);
		this.logger.info("guild-state role registry applied a role event", {
			guildId: this.guildId,
			roleId,
			created: stored === null,
			rowsWritten: written.rowsWritten,
			// Field names only: a completed field is a fact about the payload, not a fact worth its value (R14).
			completedFieldCount: description.completedFields.length,
			...(description.positionAssumed ? { positionAssumed: true } : {})
		});

		return {
			status: "applied",
			guildId: this.guildId,
			roleId,
			created: stored === null,
			rowsWritten: written.rowsWritten,
			completedFields: description.completedFields
		};
	};

	/** R1: a foreign event is named and counted, never stored, and never logged with anything but its ids. */
	private dropForeignGuild(eventGuildId: DiscordIdentifier, roleId: DiscordIdentifier): UpsertRoleOutcome {
		this.logger.warn("guild-state dropped a role event for another guild", {
			guildId: this.guildId,
			eventGuildId,
			roleId,
			operation: "upsert-role"
		});
		return { status: "dropped", guildId: this.guildId, roleId, reason: "foreign-guild" };
	}

	/**
	 * R3's error case, reported rather than worked around: role data is not this command's to invent. The reason
	 * travels with the ids so the anomaly path (R11) can complete the description from the REST role list.
	 */
	private refuse(
		roleId: DiscordIdentifier,
		description: Extract<RoleDescriptionOutcome, { status: "refused" }>
	): UpsertRoleOutcome {
		this.logger.warn("guild-state refused a role event that described an unknown role incompletely", {
			guildId: this.guildId,
			roleId,
			reason: "incomplete-role-description",
			missingFields: description.missingFields
		});
		return {
			status: "refused",
			guildId: this.guildId,
			roleId,
			reason: "incomplete-role-description",
			missingFields: description.missingFields
		};
	}

	/** `role_position` is an `integer` column; a fractional or non-finite value is refused, never rounded (R3). */
	private requireStorablePosition(position: number | undefined): void {
		if (position === undefined || Number.isInteger(position)) {
			return;
		}
		throw new InvalidRegistryFieldValueError("guild_role.role_position", "expected a whole number");
	}
}
