import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";

/**
 * The outbound port guild-state calls when a channel event just turned the bot from "cannot view" into "can
 * view" (`odd/tasks/ingestion-channel-access-trigger.md` S1, S3).
 *
 * **Why a port and not an event.** The fact belongs to this feature: the transition is decided here, from the
 * overwrite change this feature already applies, by the derivation this feature owns. The consequence belongs
 * to ingestion: walk that channel's history. Neither feature may reach the other — guild-state importing
 * ingestion would give the registry a dependency on a consumer and a second reason to run a REST job, and
 * ingestion re-deriving viewability would be a second permission authority. So the fact crosses through this
 * one-method callback, satisfied at composition (`app.module.ts`) and never here.
 *
 * **Fire and forget, by contract.** `onGained` returns `void`: an implementation schedules its work and
 * returns, exactly as `application-lifecycle.ts` does for the historical import, so registering a channel can
 * never cost the event that revealed it a page read. A listener that blocked would be the one defect this
 * shape forbids, and nothing in the command's outcome would show it.
 *
 * **Ids only.** The only argument is the channel id: no name, no overwrite set, no bitfield, no channel type.
 * A consumer needs the id to read history, and every other fact about the channel is the registry's to answer
 * through its own contracts (R14).
 */
export interface ChannelsIngestibilityGained {
	/** Called once per gained transition, with the channel that became readable. */
	readonly onGained: (channelId: DiscordIdentifier) => void;
}

/**
 * The port's implementation: a listener slot the composition fills once it has resolved both sides.
 *
 * The lifetime is the application's, which is why this is a slot rather than a constructor argument: the
 * guild-state module is built before the ingestion module exists in the container, so
 * `application-lifecycle.ts` binds the listener after Nest has resolved everything and unbinds it while
 * shutting down. Between those two calls the port is a no-op — an unbound port reports nothing rather than
 * failing an event, because a registry that cannot say who is listening must still store the row.
 */
export class ChannelsIngestibilityGainedPort implements ChannelsIngestibilityGained {
	private listener: ((channelId: DiscordIdentifier) => void) | null = null;

	/** Installs the listener. One at a time: two consumers of one permission decision is not a shape this owns. */
	public readonly bind = (listener: (channelId: DiscordIdentifier) => void): void => {
		this.listener = listener;
	};

	/** Removes the listener. Idempotent, and installed again by the next `bind`. */
	public readonly unbind = (): void => {
		this.listener = null;
	};

	public readonly onGained = (channelId: DiscordIdentifier): void => {
		const listener = this.listener;
		if (listener === null) {
			return;
		}
		listener(channelId);
	};
}
