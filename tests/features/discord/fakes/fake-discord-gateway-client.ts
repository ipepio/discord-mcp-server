import { DISCORD_REQUIRED_INTENTS } from "../../../../src/features/discord/config/discord-config.interface.js";
import type { DiscordIntentName } from "../../../../src/features/discord/config/discord-config.interface.js";
import type { DiscordConfig } from "../../../../src/features/discord/config/discord-config.interface.js";
import type {
	DiscordConnectedTransition,
	DiscordConnectionObserver
} from "../../../../src/features/discord/models/domain/discord-connection-status.js";
import type { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import type { DiscordEventProducer } from "../../../../src/features/discord/models/domain/discord-event-stream.interface.js";
import type { NormalizedDiscordEvent } from "../../../../src/features/discord/models/domain/normalized-discord-event.js";
import type { RawDiscordEvent } from "../../../../src/features/discord/gateways/discord.gateway.interface.js";
import type {
	DiscordDisconnectNotice,
	DiscordGatewayClient,
	DiscordGatewayClientConfig,
	DiscordGatewayClientFactory,
	DiscordGatewayClientHandlers,
	DiscordLoginRejectionCause
} from "../../../../src/features/discord/gateways/discord.gateway.interface.js";
import { DiscordLoginRejectedError } from "../../../../src/features/discord/gateways/discord.gateway.interface.js";

/**
 * The discord.js test double (docs/features/discord.md "Implementation and proof"): a fake exposing
 * the same seam as the real adapter — emit a raw event, simulate a disconnect, reject a resume,
 * reject a login. No test contacts Discord, and every call is recorded, so ownership of the single
 * connection is asserted rather than assumed.
 */

export type FakeLoginOutcome =
	| { readonly kind: "accept" }
	| {
			readonly kind: "reject";
			readonly cause: DiscordLoginRejectionCause;
			readonly intent?: DiscordIntentName;
	  };

export type FakeResumeOutcome = { readonly kind: "resumed" } | { readonly kind: "rejected"; readonly reason: string };

const DEFAULT_LOGIN: FakeLoginOutcome = { kind: "accept" };
const DEFAULT_RESUME: FakeResumeOutcome = { kind: "resumed" };

/** One fake client. `live` is what the single-connection assertions count. */
export class FakeDiscordGatewayClient implements DiscordGatewayClient {
	public loginCalls = 0;
	public resumeCalls = 0;
	/** Set by a test that needs the R6 error path: a client that refuses to die cleanly. */
	public destroyThrows = false;
	public destroyCalls = 0;
	public live = false;

	public constructor(
		public readonly id: number,
		public readonly handlers: DiscordGatewayClientHandlers,
		private readonly guildIds: readonly string[],
		private readonly factory: FakeDiscordGatewayClientFactory
	) {}

	public readonly login = async (): Promise<void> => {
		this.loginCalls += 1;
		this.factory.noteCall(`login:${this.id}`);
		const outcome = this.factory.takeLoginOutcome();
		if (outcome.kind === "reject") {
			throw new DiscordLoginRejectedError({
				cause: outcome.cause,
				detail: `fake login rejected (${outcome.cause})`,
				...(outcome.intent === undefined ? {} : { intent: outcome.intent })
			});
		}

		this.live = true;
		this.factory.noteLive();
	};

	public readonly resumeSession = async (): Promise<void> => {
		this.resumeCalls += 1;
		this.factory.noteCall(`resume:${this.id}`);
		const outcome = this.factory.takeResumeOutcome();
		if (outcome.kind === "rejected") {
			throw new Error(`fake resume rejected: ${outcome.reason}`);
		}

		this.live = true;
		this.factory.noteLive();
	};

	public readonly destroy = async (): Promise<void> => {
		this.destroyCalls += 1;
		if (this.destroyThrows) {
			this.factory.noteCall(`destroy-refused:${this.id}`);
			throw new Error("fake client refused to close");
		}

		this.live = false;
		this.factory.noteCall(`destroy:${this.id}`);
	};

	public readonly readGuildIds = (): readonly string[] => this.guildIds;
}

export interface FakeGatewayOptions {
	/**
	 * The Guilds the connection holds; defaults to exactly the configured one. `undefined` is allowed here
	 * on purpose — a harness forwards an option it may not have set, and the fake treats that as "use the
	 * default", which is what `exactOptionalPropertyTypes` would otherwise forbid at the call site.
	 */
	readonly guildIds?: readonly string[] | undefined;
}

export class FakeDiscordGatewayClientFactory implements DiscordGatewayClientFactory {
	public readonly clients: FakeDiscordGatewayClient[] = [];
	public readonly callOrder: string[] = [];
	/** What the lifecycle asked each client to connect with: intents and Guild id are asserted here. */
	public readonly requested: DiscordGatewayClientConfig[] = [];
	public maxLiveClients = 0;

	private readonly loginOutcomes: FakeLoginOutcome[] = [];
	private readonly resumeOutcomes: FakeResumeOutcome[] = [];
	private readonly guildIds: readonly string[];
	private nextId = 1;

	public constructor(options: FakeGatewayOptions = {}) {
		this.guildIds = options.guildIds ?? ["111111111111111111"];
	}

	public create(config: DiscordGatewayClientConfig, handlers: DiscordGatewayClientHandlers): DiscordGatewayClient {
		this.callOrder.push(`create:${this.nextId}`);
		this.requested.push({ ...config, intents: [...config.intents] });
		const client = new FakeDiscordGatewayClient(this.nextId, handlers, this.guildIds, this);
		this.nextId += 1;
		this.clients.push(client);

		return client;
	}

	/** Queues one login outcome, consumed by the next `login()` call, in order. */
	public queueLogin(outcome: FakeLoginOutcome): void {
		this.loginOutcomes.push(outcome);
	}

	/** Queues one resume outcome, consumed by the next `resumeSession()` call, in order. */
	public queueResume(outcome: FakeResumeOutcome): void {
		this.resumeOutcomes.push(outcome);
	}

	/** Queues one rejected login; the next `login()` call consumes it. */
	public refuseNextLogin(cause: DiscordLoginRejectionCause = "invalid-token", intent?: DiscordIntentName): void {
		this.loginOutcomes.push({ kind: "reject", cause, ...(intent === undefined ? {} : { intent }) });
	}

	public refuseNextResume(reason = "session expired"): void {
		this.resumeOutcomes.push({ kind: "rejected", reason });
	}

	public takeLoginOutcome(): FakeLoginOutcome {
		return this.loginOutcomes.shift() ?? DEFAULT_LOGIN;
	}

	public takeResumeOutcome(): FakeResumeOutcome {
		return this.resumeOutcomes.shift() ?? DEFAULT_RESUME;
	}

	public totalLoginCalls(): number {
		return this.clients.reduce((total, client) => total + client.loginCalls, 0);
	}

	public totalResumeCalls(): number {
		return this.clients.reduce((total, client) => total + client.resumeCalls, 0);
	}

	public totalDestroyCalls(): number {
		return this.clients.reduce((total, client) => total + client.destroyCalls, 0);
	}

	public liveClients(): FakeDiscordGatewayClient[] {
		return this.clients.filter((client) => client.live);
	}

	public latest(): FakeDiscordGatewayClient {
		const last = this.clients[this.clients.length - 1];
		if (last === undefined) {
			throw new Error("the fake gateway never created a client");
		}

		return last;
	}

	public noteCall(call: string): void {
		this.callOrder.push(call);
	}

	public noteLive(): void {
		this.maxLiveClients = Math.max(this.maxLiveClients, this.liveClients().length);
	}

	/** Emits one raw gateway dispatch through the live client, exactly as the transport would. */
	public emitRaw(eventName: string, payload: unknown): void {
		const live = this.liveClients()[0];
		if (live === undefined) {
			throw new Error("no live fake client to emit through");
		}

		live.handlers.onRawEvent({ eventName, payload });
	}

	/** Simulates the transport reporting a lost connection. */
	public emitDisconnect(notice: DiscordDisconnectNotice = { cause: "network" }): void {
		const live = this.liveClients()[0];
		if (live === undefined) {
			throw new Error("no live fake client to report a disconnect");
		}

		live.handlers.onDisconnected(notice);
	}
}

/** The Installation configuration every test shares. */
export function fakeConfig(overrides: Partial<DiscordConfig> = {}): DiscordConfig {
	return {
		botToken: "fake.bot.token.value",
		guildId: "111111111111111111",
		intents: DISCORD_REQUIRED_INTENTS,
		...overrides
	};
}

/** Records what the lifecycle reported, so signaling never depends on the transport. */
export class RecordingConnectionObserver implements DiscordConnectionObserver {
	public readonly connected: DiscordConnectedTransition[] = [];
	public readonly unavailable: string[] = [];

	public readonly onConnected = (transition: DiscordConnectedTransition): void => {
		this.connected.push(transition);
	};

	public readonly onUnavailable = (reason: string): void => {
		this.unavailable.push(reason);
	};
}

/** Collects whatever the intake publishes; used before the stream exists and after it does. */
export class RecordingIntake {
	public readonly published: NormalizedDiscordEvent[] = [];
	public readonly received: RawDiscordEvent[] = [];

	public readonly handle = (event: RawDiscordEvent): void => {
		this.received.push(event);
	};

	public kinds(): DiscordEventKind[] {
		return this.published.map((event) => event.kind);
	}
}

/** The producer seam used by intake tests: records what normalization handed to the stream. */
export class RecordingProducer implements DiscordEventProducer {
	public readonly published: NormalizedDiscordEvent[] = [];

	public readonly publish = (event: NormalizedDiscordEvent): void => {
		this.published.push(event);
	};

	public kinds(): DiscordEventKind[] {
		return this.published.map((event) => event.kind);
	}
}

/** Deterministic clock: tests move time instead of waiting for it. */
export function fakeClock(startIso = "2026-11-05T12:00:00.000Z"): {
	readonly clock: () => Date;
	readonly advance: (milliseconds: number) => void;
} {
	let current = new Date(startIso).getTime();

	return {
		clock: () => new Date(current),
		advance: (milliseconds: number) => {
			current += milliseconds;
		}
	};
}

/** A wait that resolves immediately and records the delay it was asked to apply: backoff is asserted, never slept through. */
export function fakeWait(): { readonly wait: (milliseconds: number) => Promise<void>; readonly delays: number[] } {
	const delays: number[] = [];

	return {
		delays,
		wait: async (milliseconds: number): Promise<void> => {
			delays.push(milliseconds);
		}
	};
}

/**
 * Clock and wait together, for the paths where the elapsed time itself is the thing under test: a bounded
 * drain window (R6) only expires if waiting moves the clock, so the window is elapsed deterministically
 * instead of slept through.
 */
export function fakeTimer(startIso = "2026-11-05T12:00:00.000Z"): {
	readonly clock: () => Date;
	readonly advance: (milliseconds: number) => void;
	readonly wait: (milliseconds: number) => Promise<void>;
	readonly delays: number[];
} {
	const timing = fakeClock(startIso);
	const delays: number[] = [];

	return {
		clock: timing.clock,
		advance: timing.advance,
		delays,
		wait: async (milliseconds: number): Promise<void> => {
			delays.push(milliseconds);
			timing.advance(milliseconds);
		}
	};
}
