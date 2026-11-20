import type { DiscordIdentifier } from "./discord-identifier.js";
import type { DiscordPermission } from "./discord-permissions.js";
import { ALL_DISCORD_PERMISSION_BITS, bitsIncludePermission, permissionsInBits } from "./discord-permissions.js";
import type { PermissionBitfield } from "./permission-bitfield.js";
import { fromPermissionBits, toPermissionBits } from "./permission-bitfield.js";
import type { RegistryChannel, RegistryChannelOverwrite, RegistryPermissionSnapshot } from "./registry-records.js";
import { everyoneRoleIdFor } from "./registry-rules.js";

/**
 * The effective-permission derivation (docs/features/guild-state.md R12, Contracts: "Derivation order,
 * fixed here"; docs/adr/0005). This module is the security core, and it is pure: it takes one
 * {@link RegistryPermissionSnapshot} — everything a decision needs, from one consistent read — and returns
 * the bit set. It issues no read, no write, no REST call, and it cannot be told what a permission is by a
 * caller (R13).
 *
 * The order is normative and every branch below is numbered against it:
 *
 * 1. the base is the `@everyone` role's bitfield unioned with the bitfield of every role in the member's
 *    stored role set;
 * 2. a base that includes `administrator` grants every permission and skips the overwrite stages;
 * 3. the target channel's `@everyone` overwrite: deny cleared first, then allow applied;
 * 4. the union of the member's role overwrites on that channel: the union of the denies cleared, then the
 *    union of the allows applied;
 * 5. the member-specific overwrite for that channel, if one is stored: same clear-then-apply order.
 *
 * A thread is evaluated with its own stored overwrite set over the parent channel's set, so the parent's
 * restrictions still apply when the thread carries none (Contracts). R8's private-thread admission is
 * applied after stage 2 and before the overwrite stages: a private thread the registry holds no membership
 * edge for yields the empty set, because the registry's own contract says "the visible set of a private
 * thread is exactly these ids" (`repositories/thread-membership-registry.repository.ts`) and evaluation must
 * never treat an unknown thread-membership state as granted (R8). An `administrator` base still wins: stage
 * 2 is specified to grant everything and skip the stages, and it outranks them by that wording.
 *
 * Every arithmetic step runs on `BigInt` (docs/adr/0005, O2). Text crosses the boundary exactly twice —
 * {@link toPermissionBits} on stored values, {@link fromPermissionBits} on the result — so a bit above 2^53
 * survives every stage instead of being rounded away by a `Number` (R3).
 */

/** The overwrite target kinds, in Discord's own vocabulary (R6, R7). */
const ROLE_TARGET = "role";

const MEMBER_TARGET = "member";

/**
 * R8's gated channel type, named once here rather than scattered as a string literal. The vocabulary is the
 * registry record's own channel type — the `discord` adapter has already mapped Discord's thread type 12
 * onto that name before a row was written, and this rule reads rows (docs/architecture/structure.md: a
 * cross-feature contract, consumed at the boundary, not re-imported by a business rule).
 */
type RegistryChannelType = RegistryChannel["channelType"];

export const PRIVATE_THREAD_CHANNEL_TYPE: RegistryChannelType = "private-thread";

/**
 * Why an empty set was produced. Each one is a fail-closed decision about *stored state*, never a technical
 * failure — a read that broke is thrown as `EffectivePermissionEvaluationError`, because "the hub could not
 * decide" and "you may not see it" are different facts (docs/features/query.md R2).
 */
export type EffectivePermissionEmptyReason =
	| "guild-not-registered"
	| "channel-not-registered"
	| "membership-not-registered"
	| "everyone-role-not-registered"
	| "private-thread-not-admitted";

/** The derived set: exact decimal text, the named permissions it contains, and the named lookup. */
export interface EffectivePermissionSet {
	/** Discord's own encoding: unsigned decimal text, never a number (R3). */
	readonly bitfield: PermissionBitfield;
	/** The named permissions present, in ascending bit order. */
	readonly granted: readonly DiscordPermission[];
	/** The named lookup the spec's output promises: `permissions.has("view-channel")`. */
	readonly has: (permission: DiscordPermission) => boolean;
}

/** One derivation: the set, and the facts about how it was reached. */
export interface EffectivePermissionDerivation {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
	/** `evaluated` when stored state produced the set, `empty` when the derivation refused (fail closed). */
	readonly status: "evaluated" | "empty";
	/** Set exactly when `status` is `empty`; `null` otherwise. */
	readonly reason: EffectivePermissionEmptyReason | null;
	readonly permissions: EffectivePermissionSet;
	/** True when stage 2's `administrator` bypass granted everything and skipped the overwrite stages. */
	readonly administratorBypass: boolean;
	/** The channels whose overwrite sets were applied, outermost parent first (Contracts' thread rule). */
	readonly overwriteLevels: readonly DiscordIdentifier[];
}

/** Everything one derivation reads. Produced by exactly one snapshot read (spec Contracts, R12). */
export interface EffectivePermissionDerivationInput {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
	readonly snapshot: RegistryPermissionSnapshot;
}

/**
 * The bounded registry-wide pass the two list queries need (spec Contracts: `ListUserAccessibleChannelsQuery`
 * is computed "in one bounded set read (never a per-channel round-trip loop)"). The snapshot arrives already
 * wide — `channelId: null` on the read — so this is one pass over rows in hand: no second read, no per-channel
 * round trip, and every channel is judged by exactly the same {@link deriveEffectivePermissions} the single
 * decision uses, so a list can never disagree with a decision about the same channel.
 */
export interface EffectivePermissionScanInput {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	readonly snapshot: RegistryPermissionSnapshot;
}

/** One stored channel and the decision taken over it, paired so a list never re-finds a row by id. */
export interface RegistryChannelDerivation {
	readonly channel: RegistryChannel;
	readonly derivation: EffectivePermissionDerivation;
}

export function scanEffectivePermissionsAcrossRegistry(
	input: EffectivePermissionScanInput
): readonly RegistryChannelDerivation[] {
	return input.snapshot.channels.map((channel) => ({
		channel,
		derivation: deriveEffectivePermissions({ ...input, channelId: channel.channelId })
	}));
}

/**
 * The distinct fail-closed reasons behind a scan that granted nothing, for a list query to report instead of
 * an empty array that could mean "no access" or "nothing was evaluated" (spec R6, R13: distinct facts, never
 * conflated). Empty when at least one channel produced a real decision, because then the list itself is the
 * answer. A scan over an empty registry has no derivations to read a reason from, and `channel-not-registered`
 * is the honest name for it.
 */
export function distinctRefusalReasons(
	derivations: readonly EffectivePermissionDerivation[]
): readonly EffectivePermissionEmptyReason[] {
	if (derivations.some((derivation) => derivation.status === "evaluated")) {
		return [];
	}
	if (derivations.length === 0) {
		return ["channel-not-registered"];
	}
	const reasons = new Set<EffectivePermissionEmptyReason>();
	for (const derivation of derivations) {
		if (derivation.reason !== null) {
			reasons.add(derivation.reason);
		}
	}
	return [...reasons];
}

/** The empty set, as Discord would encode it. */
export function emptyEffectivePermissionSet(): EffectivePermissionSet {
	return { bitfield: "0", granted: Object.freeze([] as readonly DiscordPermission[]), has: () => false };
}

/** The set a bit value renders to. Exported because the list queries report named lookups too (R13). */
export function effectivePermissionSetFromBits(bits: bigint): EffectivePermissionSet {
	return {
		bitfield: fromPermissionBits(bits),
		granted: permissionsInBits(bits),
		has: (permission: DiscordPermission) => bitsIncludePermission(bits, permission)
	};
}

/**
 * The one predicate every caller of the derivation asks: does this decision grant `view-channel`?
 *
 * It is exported rather than re-spelled at each call site because "the bot can view this channel" is read by
 * more than one use case — the ingestible-channel list and the channel-access trigger — and two spellings of
 * it are two chances to disagree about the same decision. An `empty` derivation answers `false` here by
 * construction (its set is empty), so a registry that could not be evaluated never reads as a grant.
 */
export function grantsViewChannel(derivation: EffectivePermissionDerivation): boolean {
	return derivation.permissions.has("view-channel");
}

/**
 * The whole point of the task: one channel, one user, one snapshot, one answer. The function reads nothing
 * and writes nothing; given the same snapshot it returns the same text, which is what makes the query's
 * read-only purity (R13) a property of this file rather than a promise about it.
 */
export function deriveEffectivePermissions(input: EffectivePermissionDerivationInput): EffectivePermissionDerivation {
	const { snapshot } = input;
	const refuse = (reason: EffectivePermissionEmptyReason): EffectivePermissionDerivation =>
		derivation(input, emptyEffectivePermissionSet(), false, [], "empty", reason);

	// R1: the registry holds one Guild and every read is scoped to it. No row means nothing to evaluate from.
	if (snapshot.guild === null || snapshot.guild.guildId !== input.guildId) {
		return refuse("guild-not-registered");
	}

	const channel = snapshot.channels.find(
		(candidate) => candidate.channelId === input.channelId && candidate.guildId === input.guildId
	);
	// R6, fail closed: a channel the registry does not hold — deleted, never seen, or another Guild's — has no
	// stored state to derive from. This is the case whose alternative was an error that reads as "no access".
	if (channel === undefined) {
		return refuse("channel-not-registered");
	}

	const membership = snapshot.membership;
	// R4, fail closed: `null` is "not a member", not "a member with no roles" — a non-member holds nothing.
	if (membership === null || membership.userId !== input.userId || membership.guildId !== input.guildId) {
		return refuse("membership-not-registered");
	}

	// Stage 1. R3: `@everyone`'s role id equals the Guild id and is not listed in a member's role set, so it is
	// folded here from the role row rather than from the assignment table. Its absence is not "grants nothing":
	// it means the registry never stored the role the Guild event was required to carry, and a derivation from
	// an incomplete base is refused.
	const everyoneRoleId = everyoneRoleIdFor(input.guildId);
	if (snapshot.everyonePermissions === null) {
		return refuse("everyone-role-not-registered");
	}
	const memberRoleIds = membership.roleIds.filter((roleId) => roleId !== everyoneRoleId);
	const base = stageOneBase(snapshot, memberRoleIds);

	// Stage 2: the bypass Discord documents for `administrator` — everything granted, overwrite stages skipped.
	if (bitsIncludePermission(base, "administrator")) {
		return derivation(
			input,
			effectivePermissionSetFromBits(ALL_DISCORD_PERMISSION_BITS),
			true,
			[],
			"evaluated",
			null
		);
	}

	// R8's admission, before the overwrite stages: a private thread the registry holds no edge for grants
	// nothing to anybody, because the thread-membership set *is* its visible set (spec R8, and the contract
	// note quoted in this file's header). Public and announcement threads are not gated: roles and overwrites
	// decide those, which is the whole of Contracts' derivation for them.
	if (channel.channelType === PRIVATE_THREAD_CHANNEL_TYPE && !snapshot.privateThreadIds.includes(input.channelId)) {
		return refuse("private-thread-not-admitted");
	}

	// Contracts' thread rule: the parent's set first, then the thread's own, so a thread that carries no
	// overwrites is still restricted by its parent. A top-level channel is the single level.
	const levels = resolvedOverwriteLevels(snapshot, channel);
	let bits = base;
	for (const level of levels) {
		bits = applyOverwriteLevel(bits, level, everyoneRoleId, memberRoleIds, membership.userId);
	}

	return derivation(
		input,
		effectivePermissionSetFromBits(bits),
		false,
		levels.map((level) => level.channelId),
		"evaluated",
		null
	);
}

/**
 * Stage 1's union. A role id the member's set names but the role registry does not hold contributes nothing
 * (R5's error case: no bitfield to add, never a guessed one), which is why the fold reads the snapshot's
 * rows rather than trusting the assignment list.
 */
function stageOneBase(snapshot: RegistryPermissionSnapshot, memberRoleIds: readonly DiscordIdentifier[]): bigint {
	let bits = toPermissionBits("guild_role.permissions_bitfield(@everyone)", snapshot.everyonePermissions);
	for (const roleId of memberRoleIds) {
		const role = snapshot.rolePermissions.find((candidate) => candidate.roleId === roleId);
		if (role === undefined) {
			continue;
		}
		bits |= toPermissionBits("guild_role.permissions_bitfield", role.permissionsBitfield);
	}
	return bits;
}

/**
 * The overwrite stages, in the order Contracts fixes: `@everyone`, then the union of the member's roles, then
 * the member itself. Each stage clears what it denies *before* applying what it allows, so a deny in the same
 * row cannot be re-granted by that row's own allow, while a later stage can still restore an earlier grant —
 * which is Discord's behaviour, not an accident of this loop.
 */
function applyOverwriteLevel(
	bits: bigint,
	level: ChannelLevel,
	everyoneRoleId: DiscordIdentifier,
	memberRoleIds: readonly DiscordIdentifier[],
	userId: DiscordIdentifier
): bigint {
	let result = bits;
	for (const stage of [
		everyoneOverwriteStage(level, everyoneRoleId),
		roleOverwriteStages(level, memberRoleIds),
		memberOverwriteStage(level, userId)
	]) {
		// Stage 3, 4, 5 in order, each one clearing before it applies (Contracts).
		result = result & ~stage.deny;
		result = result | stage.allow;
	}
	return result;
}

/** One stage's pair of bit sets. `deny` is cleared first, `allow` applied second. */
interface OverwriteStage {
	readonly allow: bigint;
	readonly deny: bigint;
}

const NO_STAGE: OverwriteStage = Object.freeze({ allow: 0n, deny: 0n });

function everyoneOverwriteStage(level: ChannelLevel, everyoneRoleId: DiscordIdentifier): OverwriteStage {
	const overwrite = level.overwrites.find(
		(candidate) => candidate.targetType === ROLE_TARGET && candidate.targetId === everyoneRoleId
	);
	return overwrite === undefined ? NO_STAGE : toStage(overwrite);
}

/**
 * Stage 4: one union over every role the member holds that this channel's set names. The union is what makes
 * the stage a single clear-then-apply, so a grant on one role is not denied by another role's row inside the
 * same stage — the ordering Contracts pins.
 */
function roleOverwriteStages(level: ChannelLevel, memberRoleIds: readonly DiscordIdentifier[]): OverwriteStage {
	let allow = 0n;
	let deny = 0n;
	let found = false;
	for (const overwrite of level.overwrites) {
		if (overwrite.targetType !== ROLE_TARGET || !memberRoleIds.includes(overwrite.targetId)) {
			continue;
		}
		found = true;
		const stage = toStage(overwrite);
		allow |= stage.allow;
		deny |= stage.deny;
	}
	return found ? { allow, deny } : NO_STAGE;
}

/** Stage 5: the member-targeted row, when the channel carries one (R6 stores it like any other target). */
function memberOverwriteStage(level: ChannelLevel, userId: DiscordIdentifier): OverwriteStage {
	const overwrite = level.overwrites.find(
		(candidate) => candidate.targetType === MEMBER_TARGET && candidate.targetId === userId
	);
	return overwrite === undefined ? NO_STAGE : toStage(overwrite);
}

function toStage(overwrite: RegistryChannelOverwrite): OverwriteStage {
	return {
		allow: toPermissionBits("channel_permission_overwrite.allow_bitfield", overwrite.allowBitfield),
		deny: toPermissionBits("channel_permission_overwrite.deny_bitfield", overwrite.denyBitfield)
	};
}

/** One level of the chain: a channel and the overwrite rows the registry holds for it. */
interface ChannelLevel {
	readonly channelId: DiscordIdentifier;
	readonly overwrites: readonly RegistryChannelOverwrite[];
}

/**
 * The chain Contracts describes as "its own stored overwrite set over the parent channel's set": parent
 * first, target last. A channel with no stored overwrite rows contributes an empty set, which is a real
 * state — R7's replacement makes "no rows" mean "no overwrites", never "unknown".
 */
function resolvedOverwriteLevels(
	snapshot: RegistryPermissionSnapshot,
	channel: RegistryChannel
): readonly ChannelLevel[] {
	const level = (channelId: DiscordIdentifier): ChannelLevel => ({
		channelId,
		overwrites: overwriteSetOf(snapshot, channelId)
	});
	const parentChannelId = channel.parentChannelId;
	const parent =
		parentChannelId === null
			? undefined
			: snapshot.channels.find(
					(candidate) => candidate.channelId === parentChannelId && candidate.guildId === channel.guildId
				);
	// A thread whose parent the snapshot does not hold is evaluated on its own set alone. R6 makes that state
	// unproducible — a stored thread always has a resolvable parent, and a parent deletion cascades its threads
	// — so the only way to reach it is a registry that no longer describes the row it came from.
	if (parent === undefined) {
		return [level(channel.channelId)];
	}
	return [level(parent.channelId), level(channel.channelId)];
}

function overwriteSetOf(
	snapshot: RegistryPermissionSnapshot,
	channelId: DiscordIdentifier
): readonly RegistryChannelOverwrite[] {
	const stored = snapshot.overwriteSets.find((candidate) => candidate.channelId === channelId);
	return stored?.overwrites ?? [];
}

function derivation(
	input: EffectivePermissionDerivationInput,
	permissions: EffectivePermissionSet,
	administratorBypass: boolean,
	overwriteLevels: readonly DiscordIdentifier[],
	status: EffectivePermissionDerivation["status"],
	reason: EffectivePermissionEmptyReason | null
): EffectivePermissionDerivation {
	return {
		guildId: input.guildId,
		userId: input.userId,
		channelId: input.channelId,
		status,
		reason,
		permissions,
		administratorBypass,
		overwriteLevels
	};
}
