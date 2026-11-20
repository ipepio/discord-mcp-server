import type { NormalizedChannelType } from "../../../discord/index.js";
import type { DiscordIdentifier } from "./discord-identifier.js";
import { ThreadParentRequiredError } from "./guild-state-registry.errors.js";
import type { RegistryChannel } from "./registry-records.js";

/**
 * The two registry rules that are guild-state's own, stated once, in code (docs/features/guild-state.md
 * R1 and R6). The PostgreSQL adapters call these before a statement runs, so a row that breaks them is
 * rejected by the feature rather than by a constraint error a caller would have to interpret.
 *
 * The thread types are listed here, against the `discord` feature's normalized vocabulary, because thread-
 * ness is a registry rule and the type names are a cross-feature contract this feature consumes. A type
 * that is unknown to the table is not a thread: an unnamed kind must never be stored parentless on the
 * strength of a guess, and it must never be dropped silently either.
 */
const THREAD_CHANNEL_TYPES: readonly NormalizedChannelType[] = Object.freeze([
	"announcement-thread",
	"public-thread",
	"private-thread"
]);

export function isThreadChannelType(channelType: NormalizedChannelType): boolean {
	return THREAD_CHANNEL_TYPES.includes(channelType);
}

/**
 * Thread-ness is derived, never declared by a caller: a write path cannot mark a thread as a channel to
 * dodge the parent rule (R6).
 */
export function registryChannelIsThread(channel: RegistryChannel): boolean {
	return isThreadChannelType(channel.channelType);
}

/**
 * R6, the error case: "a thread with no resolvable parent in the registry — the registry rejects it". The
 * schema reinforces the same rule with `channel_thread_has_parent`, so a race cannot smuggle a parentless
 * thread past the code.
 */
export function requireThreadParent(channel: RegistryChannel): void {
	if (registryChannelIsThread(channel) && channel.parentChannelId === null) {
		throw new ThreadParentRequiredError(channel.guildId, channel.channelId, channel.channelType);
	}
}

/**
 * R3, the boundary case: `@everyone` is not listed in a member's role set, and its role id equals the
 * Guild id, so evaluation folds it in by Guild id. Named here so the rule is stated once and a later task
 * cannot "discover" it inside a SQL literal.
 */
export function everyoneRoleIdFor(guildId: DiscordIdentifier): DiscordIdentifier {
	return guildId;
}

/**
 * R1: a record that names a Guild other than the configured one belongs to nobody's registry. The
 * comparison is on the id alone; the caller decides whether to count it, because a dropped row is an
 * anomaly and an anomaly is reported, not swallowed.
 */
export function isForeignGuildRecord(recordGuildId: DiscordIdentifier, configuredGuildId: DiscordIdentifier): boolean {
	return recordGuildId !== configuredGuildId;
}
