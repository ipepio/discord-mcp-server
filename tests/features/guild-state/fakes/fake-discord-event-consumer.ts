import type { DiscordEventKind } from "../../../../src/features/discord/index.js";
import type {
	DiscordEventConsumer,
	DiscordEventHandler,
	DiscordEventSubscription,
	NormalizedDiscordEvent,
	NormalizedEventOf
} from "../../../../src/features/discord/index.js";

/**
 * The `DiscordEventConsumer` double the guild-state binding is tested against (docs/features/discord.md
 * Contracts: "the consumer-facing contract is `DiscordEventConsumer`"). It implements the subscription
 * contract exactly — registration by kind, an `unsubscribe` per registration, nothing else — so the binding
 * cannot be exercised against a seam the real stream does not offer.
 *
 * What it adds is the half the public contract deliberately withholds: the ability to hand it an event.
 * `DISCORD_EVENT_STREAM_TOKEN` exports a consumer, never the publish path (docs/features/discord.md R8), so a
 * test that wanted delivery had to either reach an internal adapter or invent its own seam. Recording the
 * registrations and replaying them keeps the assertion where it belongs: on the kinds the binding registered
 * and on the order it registered them in.
 */
type StoredHandler = (event: NormalizedDiscordEvent) => void | Promise<void>;

/**
 * The dispatch invariant the real stream states and this double must share: the registration key is the
 * proof of an event's kind, so a stored handler is widened to the event union and the key is re-checked
 * before it runs. `deliver` below is what holds that invariant, and a mismatch is a programming error in
 * this file rather than input from outside it — so it throws instead of handing a handler wrong data.
 */
function narrowToKind<K extends DiscordEventKind>(kind: K, event: NormalizedDiscordEvent): NormalizedEventOf<K> {
	if (event.kind !== kind) {
		throw new Error(`fake consumer dispatch error: event of kind ${event.kind} for handler of kind ${kind}`);
	}

	return event as NormalizedEventOf<K>;
}

export class FakeDiscordEventConsumer implements DiscordEventConsumer {
	/** Every registration still active, in registration order. */
	private readonly active: { readonly kind: DiscordEventKind; readonly handler: StoredHandler }[] = [];

	/** Every registration this consumer ever received, so a test can see an unsubscribe take effect. */
	public readonly history: { readonly kind: DiscordEventKind; readonly unsubscribed: boolean }[] = [];

	public subscribe<K extends DiscordEventKind>(kind: K, handler: DiscordEventHandler<K>): DiscordEventSubscription {
		const stored: StoredHandler = (event) => handler(narrowToKind(kind, event));
		const registration = { kind, handler: stored };
		this.active.push(registration);
		const historyEntry = { kind, unsubscribed: false };
		this.history.push(historyEntry);

		return {
			unsubscribe: () => {
				const index = this.active.indexOf(registration);
				if (index >= 0) {
					this.active.splice(index, 1);
				}
				historyEntry.unsubscribed = true;
			}
		};
	}

	/**
	 * Deliver one event the way the stream would: to every active handler of its kind, in registration order,
	 * awaited. Returns how many handlers ran, which is how a test proves a kind was or was not bound.
	 */
	public async deliver(event: NormalizedDiscordEvent): Promise<number> {
		const handlers = this.active
			.filter((registration) => registration.kind === event.kind)
			.map((entry) => entry.handler);
		for (const handler of handlers) {
			await handler(event);
		}
		return handlers.length;
	}

	/** The kinds currently registered, in registration order. */
	public get boundKinds(): DiscordEventKind[] {
		return this.active.map((registration) => registration.kind);
	}

	/** How many handlers one kind would reach right now: 0 unbound, 1 bound once, 2 a double subscription. */
	public handlerCountFor(kind: DiscordEventKind): number {
		return this.active.filter((registration) => registration.kind === kind).length;
	}
}
