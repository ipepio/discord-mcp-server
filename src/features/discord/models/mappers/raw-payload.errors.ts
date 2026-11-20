/** Raised when a raw payload cannot be normalized: the raw event name, the field path and the reason (R3). */
export class MalformedRawPayloadError extends Error {
	public readonly code = "DISCORD_RAW_PAYLOAD_MALFORMED";

	/** `fieldPath` names the offending path only; it never carries the value, which may be content. */
	constructor(
		public readonly rawEventName: string,
		public readonly fieldPath: string,
		public readonly reason: string
	) {
		super(`Raw Discord event ${rawEventName} was rejected at ${fieldPath || "<root>"}: ${reason}`);
		this.name = "MalformedRawPayloadError";
	}
}
