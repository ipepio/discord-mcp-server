import type { RegistryChannelType } from "./channel-capability.js";
import { isTextCapableChannelType } from "./channel-capability.js";

/**
 * The channel-access trigger's rule (`odd/tasks/ingestion-channel-access-trigger.md` S1, S2, S3).
 *
 * One question, asked once: **did this event just turn the bot from "cannot view this channel" into "can view
 * it", on a channel where a message can be posted?** Ingestion's history walk starts from that answer, so the
 * whole of "when does a newly-granted channel begin to be ingested?" is the predicate below.
 *
 * Three boundaries are the content of the rule, and each one is a case a naive "any channel update" trigger
 * gets wrong:
 *
 * - **The transition, never the event.** A rename, a reorder or a topic change reaches this module with
 *   `before === after` and is `unchanged`. Discord sends a `CHANNEL_UPDATE` for all of them.
 * - **Gaining only.** Losing view (`lost`) is a real change and is reported as one, but it is not a trigger:
 *   there is nothing new to read, and the registry keeps serving the channels it still sees (S2).
 * - **Text-capable only.** A category and a voice channel carry no messages at all (guild-state's
 *   text-capability rule, shared here rather than restated), so a gain on one of them can never start a walk
 *   that would read nothing. A `gained` on such a channel is still reported as a gain; it is simply not
 *   ingestible.
 *
 * The rule reads no state and writes none: `before` and `after` are the bot's effective `view-channel`
 * decision on each side of the overwrite replacement, produced by the registry's committed five-stage
 * derivation (`effective-permission-rules.ts`). This module never derives a permission itself — a second
 * derivation is exactly the defect the trigger is meant to avoid.
 */

/** What one channel's bot viewability did across one applied event. */
export type BotViewabilityTransition = "gained" | "lost" | "unchanged";

/** The two decisions, and the channel type that decides whether a gain is ingestible. */
export interface ChannelViewabilityChange {
	readonly channelType: RegistryChannelType;
	/** The bot's effective `view-channel` decision from the stored state *before* this event's overwrites. */
	readonly before: boolean;
	/** The same decision from the stored state *after* it. */
	readonly after: boolean;
}

/** One evaluated transition, with the facts it was decided from. */
export interface ChannelAccessTransition {
	readonly channelType: RegistryChannelType;
	readonly before: boolean;
	readonly after: boolean;
	readonly transition: BotViewabilityTransition;
	/** The trigger S1 names: unviewable → viewable, on a channel that can carry text. */
	readonly ingestibilityGained: boolean;
}

export function detectChannelAccessTransition(change: ChannelViewabilityChange): ChannelAccessTransition {
	const transition = viewabilityTransition(change.before, change.after);
	return {
		channelType: change.channelType,
		before: change.before,
		after: change.after,
		transition,
		ingestibilityGained: transition === "gained" && isTextCapableChannelType(change.channelType)
	};
}

function viewabilityTransition(before: boolean, after: boolean): BotViewabilityTransition {
	if (before === after) {
		return "unchanged";
	}
	return after ? "gained" : "lost";
}
