/** The request fields the limiter needs; exported so tests can drive the same shape as Express. */
export interface ClientAddressRequest {
	readonly headers: Readonly<Record<string, unknown>>;
	readonly socket?: { readonly remoteAddress?: unknown };
}

const MAX_ADDRESS_LENGTH = 64;

/** IPv4-mapped IPv6 peers (`::ffff:203.0.113.9`) keep one stable key. */
function normalize(address: string): string {
	const trimmed = address.trim();
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
	return (mapped?.[1] ?? trimmed).slice(0, MAX_ADDRESS_LENGTH);
}

/**
 * One trusted-proxy hop: the proxy appends the client address to `X-Forwarded-For`, so the rightmost
 * entry is authoritative and the client-controlled entries to its left are ignored. Without the
 * header (a direct connection) the socket peer is used. The application port must never be published
 * directly; see docs/installation.md.
 */
export function clientAddress(request: ClientAddressRequest): string {
	const forwarded = request.headers["x-forwarded-for"];
	const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
	const hops =
		typeof raw === "string"
			? raw
					.split(",")
					.map((hop) => hop.trim())
					.filter((hop) => hop.length > 0)
			: [];
	const peer = typeof request.socket?.remoteAddress === "string" ? request.socket.remoteAddress : "";
	return normalize(hops.at(-1) ?? peer) || "unknown";
}
