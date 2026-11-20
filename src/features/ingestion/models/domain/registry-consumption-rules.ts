import type { ListIngestibleChannelsResult } from "../../../guild-state/index.js";

/**
 * R2's consumption rule, stated once for both walks (docs/features/ingestion.md R2: "Ingestion consumes the
 * registry contract … never consume a partial registry as authoritative").
 *
 * An ingestible-channel list is only a fact about the Guild when the registry that produced it can answer two
 * questions: does it hold the bot's own Membership, and does it hold any text-capable channel row at all.
 * Either answer being "no" makes an empty list mean *the registry has not converged*, and an import that read
 * it as *there is nothing to import* would report a Guild as imported on the strength of a table it never
 * actually looked at. That is the failure mode `ListIngestibleChannelsQuery` keeps its three counts separate
 * for, and this is where a consumer of that contract obeys it.
 *
 * The check reads only the facts the query already returns, so no extra read is invented to satisfy it and no
 * channel is silently excluded by a caller's guess about registry completeness.
 */

/** Why a registry list cannot be consumed as authoritative. `null` means it can. */
export type RegistryConsumptionBlockReason =
	/** The registry holds no row for the bot itself, so every visibility evaluation fails closed (R2, R4 there). */
	| "bot-membership-not-registered"
	/** The registry holds no text-capable channel row, so there is no denominator to read an empty list against. */
	| "registry-holds-no-text-capable-channel";

/**
 * The two conditions, in the order that says most: a registry without the bot's Membership cannot answer the
 * visibility question at all, and a registry without a single text-capable row cannot answer the completeness
 * question. Both are reported with the query's own refusal reasons alongside them.
 */
export function registryConsumptionBlockReason(
	list: Pick<ListIngestibleChannelsResult, "botMembershipRegistered" | "registeredTextCapableCount">
): RegistryConsumptionBlockReason | null {
	if (!list.botMembershipRegistered) {
		return "bot-membership-not-registered";
	}

	if (list.registeredTextCapableCount === 0) {
		return "registry-holds-no-text-capable-channel";
	}

	return null;
}
