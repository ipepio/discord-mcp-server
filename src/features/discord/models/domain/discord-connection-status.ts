/**
 * Connection status of the single Gateway connection (spec R1, R2, R11). In-process only: a restart
 * rebuilds it from configuration and nothing is persisted here (R10).
 */

export const DiscordConnectionStatus = {
	disconnected: "disconnected",
	connecting: "connecting",
	connected: "connected",
	unavailable: "unavailable"
} as const;

export type DiscordConnectionStatus = (typeof DiscordConnectionStatus)[keyof typeof DiscordConnectionStatus];

/** The observable connection state, including the instants R11 requires. */
export interface DiscordConnectionSnapshot {
	readonly status: DiscordConnectionStatus;
	readonly epoch: number;
	readonly reconnectAttempts: number;
	readonly lastConnectedInstant?: Date;
	readonly lastDisconnectedInstant?: Date;
}

/** Read side of the connection state, consumed by the status query (R11) without the adapter. */
export interface DiscordConnectionStatusSource {
	readonly read: () => DiscordConnectionSnapshot;
}

/**
 * What closing the connection produced (R6). `closed` is false only when the client refused to die: the
 * reason is a technical error name, never a payload, a credential or a wire message.
 */
export interface DiscordClosureReport {
	readonly closed: boolean;
	/** False when no client was open to close, so nothing had to be torn down. */
	readonly destroyed: boolean;
	readonly reason?: string;
}

/** What the composition root needs from the lifecycle: open the one connection, read its state. */
export interface DiscordConnectionLifecycle extends DiscordConnectionStatusSource {
	readonly start: () => Promise<void>;
}

/**
 * Facts of one transition into a connected state. The lifecycle raises it; the resync signaling
 * turns it into exactly one `resync-needed` event (R5). Keeping this a seam means the connection
 * lifecycle does not know what a signal looks like.
 */
export interface DiscordConnectedTransition {
	readonly epoch: number;
	readonly reconnectAttempts: number;
	readonly at: Date;
}

export interface DiscordConnectionObserver {
	readonly onConnected: (transition: DiscordConnectedTransition) => void;
	readonly onUnavailable: (reason: string, at: Date) => void;
}
