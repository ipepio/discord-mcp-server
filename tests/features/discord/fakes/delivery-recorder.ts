import { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import type { DiscordEventStreamGateway } from "../../../../src/features/discord/gateways/discord-event-stream.gateway.js";
import type {
	DiscordEventSubscription,
	DiscordEventHandler
} from "../../../../src/features/discord/models/domain/discord-event-stream.interface.js";
import type {
	NormalizedDiscordEvent,
	ResyncNeededEvent
} from "../../../../src/features/discord/models/domain/normalized-discord-event.js";

/** A promise that never settles: the slow-consumer seam R6 needs, without a real sleep. */
const NEVER_RESOLVES: Promise<void> = new Promise<void>(() => undefined);

/**
 * The consumer a delivery test needs: it records what reached it, in order, and can be told to fail for
 * a kind so R4's handler isolation is asserted through a real subscription rather than a stub.
 */
export class DeliveryRecorder {
	public readonly delivered: NormalizedDiscordEvent[] = [];
	public readonly callsPerKind = new Map<DiscordEventKind, number>();
	public readonly subscriptions: DiscordEventSubscription[] = [];

	private readonly failing = new Set<DiscordEventKind>();
	private readonly hanging = new Set<DiscordEventKind>();

	public constructor(private readonly stream: DiscordEventStreamGateway) {}

	/** Registers a recording handler for one kind; the kind may be made to fail at any time. */
	public observe(kind: DiscordEventKind): DiscordEventSubscription {
		const handler: DiscordEventHandler = async (event): Promise<void> => {
			this.delivered.push(event);
			this.callsPerKind.set(kind, (this.callsPerKind.get(kind) ?? 0) + 1);
			if (this.hanging.has(kind)) {
				// A consumer that never answers: only the bounded window ends it (R6).
				await NEVER_RESOLVES;
				return;
			}

			if (this.failing.has(kind)) {
				throw new Error("recording handler refused the event");
			}
		};

		const subscription = this.stream.subscribe(kind, handler);
		this.subscriptions.push(subscription);

		return subscription;
	}

	/** Makes every delivery of this kind fail, exactly like a consumer whose own write path throws. */
	public fail(kind: DiscordEventKind): void {
		this.failing.add(kind);
	}

	/**
	 * Makes every delivery of this kind run longer than the drain window: a handler awaiting a promise that
	 * never settles, which is how R6's expiry path is reached without sleeping.
	 */
	public hang(kind: DiscordEventKind): void {
		this.hanging.add(kind);
	}

	public kinds(): DiscordEventKind[] {
		return this.delivered.map((event) => event.kind);
	}

	public ofKind(kind: DiscordEventKind): NormalizedDiscordEvent[] {
		return this.delivered.filter((event) => event.kind === kind);
	}

	/** The signals that reached consumers, oldest first: R5 counts them per transition. */
	public signals(): ResyncNeededEvent[] {
		return this.delivered.filter(
			(event): event is ResyncNeededEvent => event.kind === DiscordEventKind.resyncNeeded
		);
	}

	public calls(kind: DiscordEventKind): number {
		return this.callsPerKind.get(kind) ?? 0;
	}

	public clear(): void {
		this.delivered.length = 0;
		this.callsPerKind.clear();
	}
}
