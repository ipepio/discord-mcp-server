import { requirePermissionBitfield } from "./permission-bitfield.js";
import type { PermissionBitfield } from "./permission-bitfield.js";
import type { ChannelPermissionOverwrite, NormalizedChannelType } from "../../../discord/index.js";
import type { DiscordIdentifier } from "./discord-identifier.js";
import { InvalidRegistryFieldValueError } from "./guild-state-registry.errors.js";
import type { RegistryChannel, RegistryRole } from "./registry-records.js";
import { isThreadChannelType } from "./registry-rules.js";

/**
 * The rules the Gateway-event commands apply on the way into the registry, stated once here so no command
 * can invent its own version (docs/features/guild-state.md R3, R5, R6, R7, R8, R10; the pinned tensions in
 * `odd/tasks/guild-state.md` L3).
 *
 * They all exist because a Gateway event describes its resource *less completely* than a REST snapshot does,
 * and because the payload's own claims are a transport fact this feature has already narrowed once. R10's
 * answer is the same in every case: never guess a value, and never treat "the payload did not say" as "the
 * value is empty". What may be taken from stored state, what must be reported as a gap, and what must be
 * refused outright is decided here rather than inside a write path.
 */

/** The fields of a role a `GUILD_ROLE_CREATE`/`GUILD_ROLE_UPDATE` payload may or may not carry. */
export interface RoleEventDescription {
	readonly roleId: DiscordIdentifier;
	readonly roleName?: string;
	readonly permissionsBitfield?: PermissionBitfield;
	readonly position?: number;
}

/**
 * A role event carries no position — the `discord` feature's normalized role event has no such field, because
 * Discord reports role order in the Guild's role list rather than in the role object it sends with these events.
 * Position is display-only (R3: "no v1 authorization rule depends on it"), so a role first seen through an event
 * is stored at this position, and the REST snapshot replaces it wholesale with Discord's own on the next
 * bootstrap or resync (R2, R11). No authorization field is ever defaulted this way: that is what the refusal
 * below exists for.
 */
export const ROLE_POSITION_WITHOUT_A_SOURCE = 0;

/** The whole row one role event describes, or the names of the fields no source could supply. */
export type RoleDescriptionOutcome =
	| {
			readonly status: "complete";
			readonly role: RegistryRole;
			readonly completedFields: readonly string[];
			readonly positionAssumed: boolean;
	  }
	| { readonly status: "refused"; readonly missingFields: readonly string[] };

/**
 * R3 and R10: build the whole row a role event describes.
 *
 * A field the payload carried is taken exactly as it arrived — a name verbatim, a bitfield as Discord's text (a
 * value that reached here as a JavaScript number is refused by `requirePermissionBitfield`, never coerced). A
 * field the payload did not carry is completed from the row already stored, which is Discord's own earlier
 * statement about the same resource: an absent name therefore never becomes `""` and an absent bitfield never
 * becomes `"0"`.
 *
 * A field absent from the payload *and* absent from the registry has no Discord-sourced value at all, and
 * inventing one is R3's forbidden "invented role data" — an invented bitfield would be an invented grant. Such a
 * description is refused, naming its missing fields, for the caller to report through R11's targeted REST read.
 */
export function completeRoleDescription(
	guildId: DiscordIdentifier,
	description: RoleEventDescription,
	stored: RegistryRole | null
): RoleDescriptionOutcome {
	const roleName = description.roleName ?? stored?.roleName;
	const reportedBitfield = description.permissionsBitfield;
	const permissionsBitfield =
		reportedBitfield === undefined
			? stored?.permissionsBitfield
			: requirePermissionBitfield(FIELD_BITFIELD, reportedBitfield);

	if (roleName === undefined || permissionsBitfield === undefined) {
		return { status: "refused", missingFields: missingRoleFields(roleName, permissionsBitfield) };
	}

	const completedFields: string[] = [];
	if (description.roleName === undefined) {
		completedFields.push("roleName");
	}
	if (reportedBitfield === undefined) {
		completedFields.push("permissionsBitfield");
	}

	const position = description.position ?? stored?.position;
	if (position === undefined) {
		completedFields.push("position");
	}

	return {
		status: "complete",
		role: {
			guildId,
			roleId: description.roleId,
			roleName,
			permissionsBitfield,
			position: position ?? ROLE_POSITION_WITHOUT_A_SOURCE
		},
		completedFields,
		// Named apart from `completedFields`: this one is a display default, not a Discord-sourced value.
		positionAssumed: position === undefined
	};
}

const FIELD_BITFIELD = "guild_role.permissions_bitfield";

function missingRoleFields(roleName: string | undefined, bitfield: PermissionBitfield | undefined): string[] {
	const missing: string[] = [];
	if (roleName === undefined) {
		missing.push("roleName");
	}
	if (bitfield === undefined) {
		missing.push("permissionsBitfield");
	}
	return missing;
}

/**
 * R5, bounded by the schema — the tension pinned in `odd/tasks/guild-state.md` L3. R5's error case says an
 * unknown role id is stored "as given", while `guild_membership_role` carries a foreign key to `guild_role`, so
 * PostgreSQL refuses the member's *whole* set — including the roles it really holds — when one id is unknown.
 *
 * The registry therefore stores what the foreign key allows: the ids it already holds a role row for, in the
 * order the payload carried them, and reports the rest as deferred. Nothing is dropped silently and nothing is
 * invented, and the set converges the way R10 describes — when the role definition arrives, the next complete
 * member payload (or the resync roster read, R11) writes the link. The foreign key is not relaxed to make R5's
 * sentence literal: an unresolvable grant is exactly what R3 forbids.
 */
export function partitionKnownRoleIds(
	reportedRoleIds: readonly DiscordIdentifier[],
	knownRoleIds: Iterable<DiscordIdentifier>
): {
	readonly storableRoleIds: readonly DiscordIdentifier[];
	readonly deferredRoleIds: readonly DiscordIdentifier[];
} {
	const known = new Set(knownRoleIds);
	const storableRoleIds: DiscordIdentifier[] = [];
	const deferredRoleIds: DiscordIdentifier[] = [];

	for (const roleId of reportedRoleIds) {
		if (known.has(roleId)) {
			storableRoleIds.push(roleId);
		} else {
			deferredRoleIds.push(roleId);
		}
	}

	return { storableRoleIds, deferredRoleIds };
}

/* ------------------------------------------------------------------ R6: channels and threads */

/** The fields of a channel or thread a `CHANNEL_*`/`THREAD_*` create/update payload may or may not carry. */
export interface ChannelEventDescription {
	readonly channelId: DiscordIdentifier;
	readonly channelType: NormalizedChannelType;
	readonly name?: string;
	readonly position?: number;
	readonly parentChannelId?: DiscordIdentifier | null;
}

/** Why one channel or thread event could not be written, named for R6's error bullet and R11's anomaly path. */
export type ChannelDescriptionRefusalReason = "thread-parent-missing" | "parent-not-registered";

/** The whole row one channel/thread event describes, or the reason no row could be written from it. */
export type ChannelDescriptionOutcome =
	| {
			readonly status: "complete";
			readonly channel: RegistryChannel;
			readonly completedFields: readonly string[];
	  }
	| {
			readonly status: "refused";
			readonly reason: ChannelDescriptionRefusalReason;
			readonly parentChannelId: DiscordIdentifier | null;
	  };

/**
 * Which parent id this event resolves to: the one it carried, else the one the registry already holds for the
 * same row (R10: an omitted field belongs to the row's earlier statement), else none. The command needs the
 * answer before it can ask the registry whether that parent exists, so the resolution lives here.
 */
export function resolvedParentChannelId(
	description: ChannelEventDescription,
	stored: RegistryChannel | null
): DiscordIdentifier | null {
	if (description.parentChannelId !== undefined) {
		return description.parentChannelId;
	}
	return stored?.parentChannelId ?? null;
}

/**
 * R6 and R10: build the whole row one channel/thread event describes.
 *
 * Fields the payload carried are taken exactly as they arrived; fields it did not are completed from the row
 * the registry already holds, which is Discord's own earlier statement about the same resource. A field with
 * no source anywhere stays `null` in a nullable column — a channel genuinely has no parent, and a thread event
 * genuinely carries no position — and `null` is the honest fact, never an invented name or position.
 *
 * Two refusals, both R6's error bullet:
 *
 * - A **thread** row that resolves to no parent at all is refused. A thread is never stored parentless, so the
 *   event goes back to the caller for the anomaly path instead of reaching a write.
 * - A parent id that resolves but that the registry has no row for is refused too, thread or not. Storing it
 *   would violate the parent foreign key; dropping it would store a channel the payload said has a parent as a
 *   top-level one, which is an invented row. Either way the row converges when the parent arrives (R10, R11).
 */
export function completeChannelDescription(
	guildId: DiscordIdentifier,
	description: ChannelEventDescription,
	stored: RegistryChannel | null,
	parentChannelId: DiscordIdentifier | null,
	parentRegistered: boolean
): ChannelDescriptionOutcome {
	if (parentChannelId === null) {
		if (isThreadChannelType(description.channelType)) {
			return { status: "refused", reason: "thread-parent-missing", parentChannelId: null };
		}
	} else if (!parentRegistered) {
		return { status: "refused", reason: "parent-not-registered", parentChannelId };
	}

	const completedFields: string[] = [];
	if (description.name === undefined && stored?.name !== undefined) {
		completedFields.push("name");
	}
	if (description.position === undefined && stored?.position !== undefined) {
		completedFields.push("position");
	}
	if (description.parentChannelId === undefined && stored !== null) {
		completedFields.push("parentChannelId");
	}

	return {
		status: "complete",
		channel: {
			guildId,
			channelId: description.channelId,
			channelType: description.channelType,
			name: description.name ?? stored?.name ?? null,
			position: description.position ?? stored?.position ?? null,
			parentChannelId
		},
		completedFields
	};
}

/* ------------------------------------------------------------------ R7: overwrite targets */

/**
 * The overwrite target kinds the registry can hold: `role` and `member`, Discord's own two (R7). The name is
 * checked at runtime rather than trusted from the type, because `NormalizedOverwriteTargetType` is a narrowing
 * the transport performed — a value that reaches this seam from anywhere else is still just text.
 */
const OVERWRITE_TARGET_KINDS: readonly string[] = ["role", "member"];

/** What one reported overwrite set split into: what may be stored, and what must be dropped and counted. */
export interface OverwritePartition {
	readonly storable: readonly ChannelPermissionOverwrite[];
	readonly droppedTargetIds: readonly DiscordIdentifier[];
}

/**
 * R7's error case: an overwrite whose target type is neither role nor member is dropped and counted, "never
 * guessed from the id". Guessing would be choosing a kind from an id shape, and a wrong kind moves a grant
 * between the role stage and the member stage of the derivation order (spec Contracts) — a permission result
 * no Discord payload ever described.
 *
 * Everything else the payload reported is passed through exactly as it arrived: an overwrite whose target id
 * names a role nobody holds, or a user who is not a member, is stored, because R7's boundary makes such a
 * target inert at evaluation time and only evaluation (T7) knows the member's roles. The bitfields of the
 * storable entries are re-validated here, so a value that arrived as a number is refused before any write
 * rather than coerced into a grant.
 */
export function partitionOverwriteTargets(overwrites: readonly ChannelPermissionOverwrite[]): OverwritePartition {
	const storable: ChannelPermissionOverwrite[] = [];
	const droppedTargetIds: DiscordIdentifier[] = [];

	for (const overwrite of overwrites) {
		if (!OVERWRITE_TARGET_KINDS.includes(overwrite.targetType)) {
			droppedTargetIds.push(overwrite.targetId);
			continue;
		}
		storable.push({
			targetId: overwrite.targetId,
			targetType: overwrite.targetType,
			allowBitfield: requirePermissionBitfield(
				"channel_permission_overwrite.allow_bitfield",
				overwrite.allowBitfield
			),
			denyBitfield: requirePermissionBitfield(
				"channel_permission_overwrite.deny_bitfield",
				overwrite.denyBitfield
			)
		});
	}

	return { storable, droppedTargetIds };
}

/* ------------------------------------------------------------------ R8: private-thread membership */

/** A thread-membership event is one of exactly two facts; anything else is not a change this rule can name. */
export type ThreadMembershipChangeKind = "added" | "removed";

const THREAD_MEMBERSHIP_CHANGES: readonly string[] = ["added", "removed"];

/**
 * R8's vocabulary, checked rather than assumed, as the overwrite kind above is. An unnamed direction is a
 * caller that has invented a third fact: there is no "absent" or "maybe" edge to write, and guessing one would
 * be guessing access, which R8 forbids. The named field is what the log line and the thrown error carry.
 */
export function requireThreadMembershipChange(field: string, change: unknown): ThreadMembershipChangeKind {
	if (typeof change === "string" && THREAD_MEMBERSHIP_CHANGES.includes(change)) {
		return change as ThreadMembershipChangeKind;
	}
	throw new InvalidRegistryFieldValueError(field, "expected 'added' or 'removed'");
}
