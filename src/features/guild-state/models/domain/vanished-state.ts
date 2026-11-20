import type { DiscordIdentifier } from "./discord-identifier.js";

/**
 * The vocabulary of the resync convergence sweep (docs/features/guild-state.md R11, with R2's bound, R10's
 * wholesale replacement and R14's logging rule).
 *
 * What a resync reads is a statement about the whole set: the role list and the channel list are unpaginated,
 * and the roster is either read to its end or flagged truncated. So a row the registry still holds for a
 * resource the read did not name did not survive the outage — a role deleted, a channel deleted, a member who
 * left without an event reaching this process — and leaving it stored would be a permission the provider has
 * already withdrawn. This file states the two things the sweep needs and nothing else: what a pass reported as
 * the whole set ({@link VanishedStateReadSets}) and what the sweep did about it
 * ({@link VanishedStateSweepReport}).
 *
 * The safety rule lives here as a type, not as a comment: the roster set carries {@link
 * VanishedStateReadSets.roster.complete}, and a sweep may only diff memberships when it is `true`. A truncated
 * roster is a partial read, and diffing a partial read turns a page bound into a mass revocation.
 */

/** The three resource sets the sweep can converge, named so a report, a log line and a gap agree. */
export const VANISHED_STATE_TARGETS = Object.freeze(["memberships", "roles", "channels"] as const);

export type VanishedStateTarget = (typeof VANISHED_STATE_TARGETS)[number];

/**
 * The whole sets one bootstrap pass read, in the ids the provider reported. Absent means *this pass did not
 * read that resource* — a part that failed, or a part the tracker already held applied — and nothing may be
 * concluded from a read that did not happen. An empty list is the opposite fact: the read finished and named
 * nothing.
 */
export interface VanishedStateReadSets {
	/** The role list, ids only. Discord's role read is unpaginated, so its presence means completeness. */
	readonly roles?: readonly DiscordIdentifier[];
	/** The channel and thread list, ids only. Unpaginated like the role read. */
	readonly channels?: readonly DiscordIdentifier[];
	/** The roster, with the bound stated: `complete: false` forbids the membership sweep (R2, R11). */
	readonly roster?: { readonly complete: boolean; readonly userIds: readonly DiscordIdentifier[] };
}

/**
 * Why the sweep declined a target. Closed vocabulary: a reason a log line and a test can both name.
 *
 * - `"foreign-guild"` — the input named a Guild other than the configured one (R1): no diff, no delete.
 * - `"not-read-in-this-pass"` — the read that would have settled the set did not run in this pass, so the
 *   registry holds rows nothing has compared (a failed part, or a part the tracker already held applied).
 * - `"roster-truncated"` — the roster stopped at its page bound. A partial roster is not a departure list, and
 *   ending memberships from one would be a mass revocation out of a pagination limit (R2, R11).
 */
export type VanishedStateSkipReason = "foreign-guild" | "not-read-in-this-pass" | "roster-truncated";

export interface VanishedStateSkip {
	readonly target: VanishedStateTarget;
	readonly reason: VanishedStateSkipReason;
}

/**
 * One sweep, reported in counts (R14: ids and counts, never a payload). The three headline numbers are what a
 * convergence pass removed per resource; `dependentRowsRemoved` is what the same cascades took with them — role
 * assignments, overwrite rows and thread edges — because those are the revocations that matter downstream.
 */
export interface VanishedStateSweepReport {
	readonly removedMemberships: number;
	readonly removedRoles: number;
	readonly removedChannels: number;
	readonly dependentRowsRemoved: number;
	/** The bounded groups the deletes were issued in (docs/architecture/persistence.md: bounded batches). */
	readonly batches: number;
	/** Targets the sweep refused to diff, with the reason. Empty when every read was complete. */
	readonly skipped: readonly VanishedStateSkip[];
}

/** An empty report: the shape a skipped or failed sweep reports, so a caller never reads `undefined` as zero. */
export function emptyVanishedStateSweepReport(): VanishedStateSweepReport {
	return {
		removedMemberships: 0,
		removedRoles: 0,
		removedChannels: 0,
		dependentRowsRemoved: 0,
		batches: 0,
		skipped: []
	};
}

/**
 * The ids the registry holds that a complete read no longer reports, in stored order. This is the whole of the
 * sweep's decision procedure: the read is the provider's statement about the set (R10), and the difference is
 * what the outage took.
 */
export function vanishedFromRead(
	stored: readonly DiscordIdentifier[],
	read: readonly DiscordIdentifier[]
): readonly DiscordIdentifier[] {
	const present = new Set(read);
	return stored.filter((id) => !present.has(id));
}
