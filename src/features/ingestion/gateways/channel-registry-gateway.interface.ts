import type { ListIngestibleChannelsQuery } from "../../guild-state/index.js";

/**
 * The registry contract ingestion consumes (docs/features/ingestion.md R2: "Ingestion consumes the registry
 * contract: the set of registered, non-deleted text-capable channels and threads the bot itself can view";
 * docs/features/guild-state.md Contracts: `ListIngestibleChannelsQuery`).
 *
 * The contract is guild-state's public query, narrowed to the one call this feature makes. It is not a
 * transport gateway and there is no adapter to write: the `GuildStateModule` already provides the query behind
 * `GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN`, and the composition hands that instance here — a type-only
 * import of a public surface, which is exactly what docs/architecture/structure.md requires of a cross-feature
 * call ("never another feature's controller, repository or gateway"; the boundary check enforces it).
 *
 * Narrowing to `execute` is deliberate and is what keeps R2 honest:
 *
 * - Ingestion asks **which channels it may read**, and nothing else. It cannot write the registry, cannot
 *   reach the snapshot repository behind the query and cannot evaluate permissions for a User — those are
 *   other features' use cases, and a backfill that could call them would own guild state.
 * - The result keeps bot visibility and registry absence as distinct facts
 *   (`botCannotViewChannelIds`, `registeredTextCapableCount`, `botMembershipRegistered`). A caller that read
 *   only `channels` would treat "the registry has not converged" as "there is nothing to import", which is R2's
 *   forbidden partial-registry consumption. Both walks therefore carry those facts into their reports rather
 *   than deciding from the list's length alone.
 */
export type IngestibleChannelRegistry = Pick<ListIngestibleChannelsQuery, "execute">;
