import type { DiscordRestFailureReason } from "../../../discord/index.js";
import type { DiscordIdentifier } from "./discord-identifier.js";
import type { VanishedStateReadSets } from "./vanished-state.js";

/**
 * What one REST bootstrap pass owes the registry, and the state a pass may claim afterwards
 * (docs/features/guild-state.md R2). The parts are R2's own list — the Guild row, the role list, the
 * channel list with its permission overwrites, the paginated member roster — plus the thread-member
 * reconciliation R8's coverage limit and the Contracts boundary name. The list is data, not a comment,
 * because "completion is never claimed while any part is pending" is only testable if "which parts" is
 * stated once and read by both the tracker and the command.
 *
 * Where this state lives is the recorded project decision (odd/tasks/guild-state.md, T2): **in memory, per
 * process**. A restart produces a fresh tracker with every part pending, and re-running the pass over an
 * already converged registry changes nothing observable because every registry write is keyed on Discord's
 * own ids and is idempotent (R9). Durable status semantics — `current`/`incomplete`/`stale`/`unavailable`
 * and the `GetGuildStateStatusQuery` that reports them — belong to a later task, so the tracker is a
 * contract here, not a table: it can be re-implemented on storage without a repository changing.
 */

/** The parts one bootstrap pass applies, in the order a pass applies them. */
export const GUILD_BOOTSTRAP_PARTS = Object.freeze(["guild", "roles", "channels", "roster", "thread-members"] as const);

export type GuildBootstrapPart = (typeof GUILD_BOOTSTRAP_PARTS)[number];

/** `pending` includes "applied and then forgotten by a restart": the row state may exist while the part does not. */
export type GuildBootstrapPartState = "pending" | "applied";

/** The whole tracker state at one instant. Immutable: {@link withPartApplied} returns a new snapshot. */
export interface GuildBootstrapStateSnapshot {
	readonly guildId: DiscordIdentifier;
	readonly parts: Readonly<Record<GuildBootstrapPart, GuildBootstrapPartState>>;
}

/** One part's outcome in a completed pass: what it did and how many rows it moved (R14: ids and counts). */
export interface GuildBootstrapPartReport {
	readonly part: GuildBootstrapPart;
	readonly state: GuildBootstrapPartState;
	/** Rows the registry wrote for this part in this pass; a replayed part legitimately reports zero-ish counts. */
	readonly rowsWritten: number;
}

/**
 * A part that could not be finished, stated as a fact rather than hidden: R2 forbids claiming completion
 * over a pending part, and R8 forbids inventing membership to make a gap disappear. A gap is what a later
 * resync or status read consumes.
 */
export interface GuildBootstrapGap {
	readonly part: GuildBootstrapPart;
	readonly reason: string;
	/** Present for a `thread-members` gap: the specific threads this Installation could not read (R8 boundary). */
	readonly threadIds?: readonly DiscordIdentifier[];
}

/** The report one pass returns. `complete` is the tracker's answer, never the command's hope. */
export interface GuildBootstrapReport {
	readonly guildId: DiscordIdentifier;
	readonly complete: boolean;
	readonly parts: readonly GuildBootstrapPartReport[];
	readonly gaps: readonly GuildBootstrapGap[];
	/**
	 * The whole sets this pass actually read, as ids (R10, R11). A convergence sweep diffs the registry against
	 * these, so the pass has to say what it saw rather than only what it wrote: a set absent here was not read
	 * in this pass — it failed, or the tracker already held it applied — and no sweep may conclude anything from
	 * a read that did not happen. This is a report, not a log line: ids travel, payloads never (R14).
	 */
	readonly reads: VanishedStateReadSets;
}

/** Every part pending: the state of a process that has not applied anything yet, and of every restart. */
export function initialBootstrapState(guildId: DiscordIdentifier): GuildBootstrapStateSnapshot {
	const parts = {} as Record<GuildBootstrapPart, GuildBootstrapPartState>;
	for (const part of GUILD_BOOTSTRAP_PARTS) {
		parts[part] = "pending";
	}
	return { guildId, parts: Object.freeze(parts) };
}

/** Immutably mark one part applied, leaving the rest of the state as it was. */
export function withPartApplied(
	state: GuildBootstrapStateSnapshot,
	part: GuildBootstrapPart
): GuildBootstrapStateSnapshot {
	return { guildId: state.guildId, parts: Object.freeze({ ...state.parts, [part]: "applied" }) };
}

/**
 * R2's rule as one predicate: complete only when every part is applied. Anything else — a part that failed,
 * a roster that stopped at its page bound, a thread the bot cannot observe — is not completion.
 */
export function bootstrapStateIsComplete(state: GuildBootstrapStateSnapshot): boolean {
	return GUILD_BOOTSTRAP_PARTS.every((part) => state.parts[part] === "applied");
}

/**
 * The tracker contract (T2's in-memory implementation lives in `bootstrap/in-memory-bootstrap-state.ts`).
 * Deliberately small: the pass decides what to apply, the tracker only remembers what was.
 */
export interface GuildBootstrapStateTracker {
	readonly guildId: DiscordIdentifier;
	readonly snapshot: () => GuildBootstrapStateSnapshot;
	/** In {@link GUILD_BOOTSTRAP_PARTS} order, so a pass is deterministic and testable. */
	readonly pendingParts: () => readonly GuildBootstrapPart[];
	readonly isApplied: (part: GuildBootstrapPart) => boolean;
	readonly markApplied: (part: GuildBootstrapPart) => void;
	/** Forget every applied part: what a resync (R11) asks for before it re-runs the bootstrap path. */
	readonly reset: () => void;
	readonly isComplete: () => boolean;
}

/**
 * Which read failures mean "this Installation cannot serve this Guild" — a lost access, a revoked token, a
 * Guild that is gone. R2's error case names them: the bootstrap fails loudly as `unavailable` and must not
 * degrade into an empty-but-"complete" registry. The reason vocabulary is the `discord` boundary's own
 * (docs/features/discord.md R7), consumed as types only.
 */
const GUILD_ACCESS_LOST_REASONS: readonly DiscordRestFailureReason[] = Object.freeze([
	"unauthorized",
	"not-found",
	"client-error"
]);

/** The rest — 429, 5xx, timeout, transport, validation — are technical states of a read, not a lost Guild. */
export function isGuildAccessLostReason(reason: DiscordRestFailureReason): boolean {
	return GUILD_ACCESS_LOST_REASONS.includes(reason);
}
