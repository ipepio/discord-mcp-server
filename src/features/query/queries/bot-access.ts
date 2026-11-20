import type { IngestibleChannelEntry } from "../../guild-state/index.js";
import { QueryError } from "../models/domain/query.errors.js";

/**
 * R12's bot-access axis: guild-state's `ListIngestibleChannelsQuery`, the contract ingestion enumerates from
 * (docs/features/query.md "Bot-access contract consumed from guild-state"). Only the facts this consumer
 * reads are restated, so composition injects the real query and a test double doubles the same fact. The
 * contract keeps its two absences apart and so does this seam: `channels` is what the bot can view and
 * `botCannotViewChannelIds` is what it cannot. This feature adds no second bot-visibility rule and reads no
 * registry table to obtain it; the bot's User id arrives as input, never from a tool argument (R1).
 *
 * Two tools consume the same axis — `list_channels` (R12) and the digest (R14) — so the read lives here once
 * instead of twice, which is what keeps the intersection one rule rather than two agreeing copies.
 */
export interface BotViewableChannelsReader {
	readonly execute: (input: { readonly botUserId: string }) => Promise<{
		readonly channels: readonly Pick<IngestibleChannelEntry, "channelId">[];
		readonly botCannotViewChannelIds: readonly string[];
		readonly botMembershipRegistered: boolean;
	}>;
}

/** The bot's viewable ids, or R12's `internal_error`: never an empty set standing in for an axis. */
export async function readBotViewableChannelIds(
	bot: BotViewableChannelsReader,
	botUserId: string
): Promise<ReadonlySet<string>> {
	let listed: Awaited<ReturnType<BotViewableChannelsReader["execute"]>>;
	try {
		listed = await bot.execute({ botUserId });
	} catch {
		throw new QueryError("internal_error", "Could not evaluate the bot's channel access");
	}
	// The contract keeps "the bot views nothing" apart from "the bot's own visibility is unknown" (a registry
	// that never stored the bot's Membership fails closed for every channel). Reading the second as the first
	// would answer a different question silently, which is what R12's no-single-axis rule forbids.
	if (!listed.botMembershipRegistered)
		throw new QueryError("internal_error", "Could not evaluate the bot's channel access");
	return new Set(listed.channels.map((entry) => entry.channelId));
}
