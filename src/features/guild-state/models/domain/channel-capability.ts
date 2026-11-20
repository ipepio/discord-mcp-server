import type { RegistryChannel } from "./registry-records.js";
import { isThreadChannelType } from "./registry-rules.js";

/**
 * The channel-type vocabulary this rule classifies, taken from the registry record that carries it rather
 * than imported from the feature that names it: `guild-state` stores a `RegistryChannel`, so its own record
 * type is the complete, already-boundary-mapped vocabulary (the `discord` adapter maps a Discord type code
 * onto it before a row is ever written). Stating the union this way keeps the classification rule free of a
 * cross-feature import of its own — the only place Discord's normalized names enter this feature is the
 * boundary files that map Discord data (`models/domain/registry-records.ts`, the gateway and the command
 * inputs), which is what docs/architecture/structure.md asks of a cross-feature contract.
 */
export type RegistryChannelType = RegistryChannel["channelType"];

/**
 * Which stored channel types can carry text (docs/features/guild-state.md Contracts:
 * `ListIngestibleChannelsQuery` reads "registered, non-deleted, text-capable channels and threads").
 *
 * The rule is a registry rule, not an ingestion rule: the registry knows the channel type, and ingestion
 * asks which rows are worth enumerating before it asks anything of its own. Voice, stage, category,
 * directory and the direct-message kinds are excluded because no message is posted *in* them; a forum and a
 * media channel are included because their posts are text conversations even though a message ingests under
 * the post's thread id rather than the container's (docs/features/ingestion.md R2), which is why the
 * container id stays in the list instead of being filtered out here.
 *
 * `unknown` is excluded. A channel type the `discord` feature could not name is not a type this feature may
 * guess at, and an ingestible list that silently included it would be a guess with a green test attached.
 */
const TEXT_CAPABLE_CHANNEL_TYPES: readonly RegistryChannelType[] = Object.freeze([
	"guild-text",
	"guild-announcement",
	"guild-forum",
	"guild-media",
	"announcement-thread",
	"public-thread",
	"private-thread"
]);

export function isTextCapableChannelType(channelType: RegistryChannelType): boolean {
	return TEXT_CAPABLE_CHANNEL_TYPES.includes(channelType);
}

/** The same rule read off a stored row, so a caller never re-derives thread-ness or capability separately. */
export function channelRowIsTextCapable(channel: RegistryChannel): boolean {
	return isTextCapableChannelType(channel.channelType);
}

export { isThreadChannelType };
