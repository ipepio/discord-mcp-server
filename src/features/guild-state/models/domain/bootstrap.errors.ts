import type { DiscordRestFailureReason } from "../../../discord/index.js";

/**
 * The bootstrap's own error vocabulary (docs/architecture/conventions.md: expected failures become named
 * errors). These sit beside {@link ./guild-state-registry.errors.ts}, which holds the registry's write-side
 * failures: nothing here carries a driver error, a SQL fragment or a Discord payload — an id, a reason and
 * the HTTP status the boundary reported, which is what R14 lets a log line carry.
 */

/** Base class for every guild-state bootstrap failure. */
export abstract class GuildBootstrapError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * This feature's own name for R1's boundary case, added to the `discord` boundary's reason vocabulary rather
 * than faked with a nearby HTTP reason: Discord reported the configured Guild unavailable to this connection
 * (the bot was removed from it), so no part of the registry can be current. Recovery is operator action, not
 * an automatic fallback to another Guild.
 */
export type GuildBootstrapUnavailableReason = "guild-unavailable";

/**
 * Every reason a bootstrap can stop for: the `discord` boundary's own classification plus the one fact this
 * feature adds. Kept as one type so a call site cannot pass a stray string.
 */
export type GuildBootstrapFailureReason = DiscordRestFailureReason | GuildBootstrapUnavailableReason;

/**
 * R2, the error case: a 4xx on the Guild read means the bot lost access to the configured Guild (or the
 * token was revoked, or the Guild is gone). The bootstrap stops here rather than applying the parts it can
 * still read, because a registry built from a partial view of a Guild it cannot see would be reported as
 * "complete" — exactly the state R2 forbids. `status` is the HTTP status the `discord` boundary reported,
 * kept for the log line; `reason` is that boundary's classification, or {@link
 * GuildBootstrapUnavailableReason} when Discord itself named the Guild unavailable.
 */
export class GuildBootstrapUnavailableError extends GuildBootstrapError {
	public constructor(
		public readonly guildId: string,
		public readonly reason: GuildBootstrapFailureReason,
		public readonly status?: number
	) {
		const statusPart = status === undefined ? "" : ` status ${status}`;
		super(
			`guild-state bootstrap stopped: guild ${guildId} is not readable (${reason}${statusPart}) — unavailable (R2)`
		);
	}
}

/**
 * A REST read named a Guild other than the configured one. R1 keeps the registry single-Guild and the
 * `discord` adapter already refuses to read another Guild, so this is a broken-assembly signal, not a data
 * case: it is reported loudly instead of being filtered into a pending part.
 */
export class GuildBootstrapGuildMismatchError extends GuildBootstrapError {
	public constructor(
		public readonly configuredGuildId: string,
		public readonly readGuildId: string
	) {
		super(
			`guild-state bootstrap refused a read result naming guild ${readGuildId} for the configured guild ${configuredGuildId} (R1)`
		);
	}
}
