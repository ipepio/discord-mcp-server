import type { DiscordIdentifier } from "./discord-identifier.js";

/**
 * The resync bookkeeping of one process (docs/features/guild-state.md R11, R2 status rules; the DECIDED rule
 * in `odd/tasks/guild-state.md` T2).
 *
 * T2 put the *bootstrap* parts in memory, per process, and named this file's owner: the durable status
 * semantics — `current`/`incomplete`/`stale`/`unavailable` — are what `GetGuildStateStatusQuery` reports, and
 * the facts it needs are exactly three:
 *
 * 1. **in flight** — a resync started and has not returned (R11: "while a resync is in flight the registry
 *    reports the stale/incomplete status");
 * 2. **open gaps** — a resource the registry could not complete: a refused role description, a channel whose
 *    overwrite set no payload ever carried, a roster that stopped at its bound, a thread member list this
 *    Installation may not read. R11's error case is a rule about these: a resync that cannot complete leaves
 *    the status stale, so a gap is recorded as a fact and is only removed by a completion that proves it;
 * 3. **unavailable** — the configured Guild was lost (a 4xx on a guild read, R1's boundary), the one state a
 *    converged registry cannot overwrite, because a registry for a Guild the bot may no longer see is not
 *    authoritative no matter how complete its rows look.
 *
 * Like the bootstrap tracker this is a contract, not a table: it lives in memory per process, and a restart
 * begins with nothing in flight and nothing open, which is honest because the next start re-converges through
 * the same resync path (R5 + R11) and every registry write is idempotent (R9).
 *
 * Nothing here awaits, reads or logs. It is plain data plus the key function that turns the data into a
 * status, so the status rules are stated once and shared by the command's result and the query's answer.
 */

/** The four registry statuses the spec names (R2, R11, and Contracts on `GetGuildStateStatusQuery`). */
export const GUILD_REGISTRY_STATUSES = Object.freeze(["current", "incomplete", "stale", "unavailable"] as const);

export type GuildRegistryStatus = (typeof GUILD_REGISTRY_STATUSES)[number];

/**
 * The kinds of gap this feature can hold open. Each one is the named outcome of an earlier task's rule, so a
 * status is traceable to the rule that made it:
 *
 * - `role-incomplete-description` — T3's refusal (R3 error case: a role event that described an unknown role
 *   incompletely), completed by the resync's targeted role read.
 * - `channel-pending-rest-fields` — T5's `pendingRestFields: ["permissionOverwrites"]` (R10: absent is not
 *   empty), completed by the resync's targeted channel read plus `replaceChannelOverwrites`.
 * - `role-id-deferred` — R5's error case at the FK boundary (recorded as L3): a member set naming a role the
 *   registry did not hold. Converged by the fresh roster and the fresh role list, never invented.
 * - `roster-truncated` / `thread-members-unreadable` — T2's bootstrap gaps (R2 page bound, R8's coverage limit
 *   and open decision O1). Both stay open until a read proves otherwise; nothing closes them optimistically.
 * - `resync-read-failed` — a targeted or bootstrap read that stopped mid-resync (R11's error case: keep the
 *   status stale and keep retrying).
 * - `thread-membership-unobserved` — an unknown-thread deferral (T6/R8) plus O1. It is *never* completed by the
 *   resync command, because closing it would mean inventing private-thread membership.
 */
export const REGISTRY_GAP_KINDS = Object.freeze([
	"role-incomplete-description",
	"channel-pending-rest-fields",
	"role-id-deferred",
	"roster-truncated",
	"thread-members-unreadable",
	"thread-membership-unobserved",
	"resync-read-failed"
] as const);

export type RegistryGapKind = (typeof REGISTRY_GAP_KINDS)[number];

/** One gap the registry holds open, stated by resource so a later targeted read can name what it closed. */
export interface RegistryGapRecord {
	readonly kind: RegistryGapKind;
	/** The resource the gap is about: a role id, a channel id, a thread id, or `guild` for a whole-part gap. */
	readonly resourceId: DiscordIdentifier;
	/** The reason in the shape the reporting rule already uses: field names, counts, the bound. No payload (R14). */
	readonly reason: string;
	/** Field names left without a source, for the two kinds that report fields (T3, T5). */
	readonly pendingFields?: readonly string[];
}

/** The gap key: one gap per kind and resource, so a replayed report cannot inflate the count (R9). */
export function registryGapKey(gap: RegistryGapRecord): string {
	return `${gap.kind}:${gap.resourceId}`;
}

/** Every anomaly reason a resync counts, as one closed vocabulary (R14: ids, counts and reasons only). */
export const GUILD_STATE_ANOMALY_REASONS = Object.freeze([
	"foreign-guild",
	"incomplete-role-description",
	"payload-carried-no-overwrite-set",
	"unknown-thread-membership",
	"roster-truncated",
	"thread-member-list-unreadable",
	"targeted-read-failed",
	"guild-unavailable"
] as const);

export type GuildStateAnomalyReason = (typeof GUILD_STATE_ANOMALY_REASONS)[number];

/** The whole resync state at one instant. Immutable; the ledger returns new snapshots. */
export interface GuildResyncStateSnapshot {
	readonly guildId: DiscordIdentifier;
	readonly resyncInFlight: boolean;
	/** The epoch of the signal being served, present only while one is in flight (R5's signal fact). */
	readonly resyncEpoch: number | null;
	/** The highest epoch fully served: a replayed or older signal is inert (R9). */
	readonly convergedEpoch: number | null;
	readonly unavailable: boolean;
	/** Why the Guild is unavailable — an anomaly reason, never a payload (R14). */
	readonly unavailableReason: GuildStateAnomalyReason | null;
	readonly openGaps: readonly RegistryGapRecord[];
	readonly anomalyCounts: Readonly<Partial<Record<GuildStateAnomalyReason, number>>>;
}

/** The ledger contract: what a resync may record, and what a status read may ask. */
export interface GuildResyncStateLedger {
	readonly guildId: DiscordIdentifier;
	readonly snapshot: () => GuildResyncStateSnapshot;
	/** A resync began: R11's "while a resync is in flight" window opens, and the Guild is assumed reachable. */
	readonly beginResync: (epoch: number) => void;
	/** The resync returned, converged or not. The in-flight fact clears; open gaps are what they are. */
	readonly endResync: (convergedEpoch?: number) => void;
	/** R1's boundary / R2's error: the Guild was lost. Louder than any gap, and only a good read clears it. */
	readonly markUnavailable: (reason: GuildStateAnomalyReason) => void;
	/** A read that succeeded for this Guild is the evidence that access came back (operator re-invite). */
	readonly markAvailable: () => void;
	/** Record one gap. Idempotent by {@link registryGapKey}, so a replayed report changes nothing (R9). */
	readonly recordGap: (gap: RegistryGapRecord) => void;
	/** Close one gap because a read proved it. Returns false when there was no such gap. */
	readonly resolveGap: (kind: RegistryGapKind, resourceId: DiscordIdentifier) => boolean;
	/** Every open gap of one kind, in record order. */
	readonly gapsOf: (kind: RegistryGapKind) => readonly RegistryGapRecord[];
	/** Count one anomaly by reason (R1's drop path, R3/R7 refusals, R8's deferrals, R11's failures). */
	readonly countAnomaly: (reason: GuildStateAnomalyReason, by?: number) => void;
}

/**
 * The status rules, in the one place both the resync command and the status query read them.
 *
 * Precedence, and why:
 *
 * 1. `unavailable` — a lost Guild outranks everything, because rows about a Guild this Installation may not
 *    read are not a permission authority (R1 boundary, R2 error case).
 * 2. `stale` while a resync is in flight — R11 names the window explicitly, and during it every part is
 *    pending, so the in-flight fact must win or the answer would be a vaguer word for the same situation.
 * 3. `incomplete` while bootstrap parts are pending — R2: "a partially applied bootstrap keeps the status
 *    `incomplete` and is therefore never consumed as authoritative".
 * 4. `stale` while any gap or `pendingRestFields` remain open — R11's error case: a resync that cannot
 *    complete leaves the status stale, and "it never marks the registry current on a partial read".
 * 5. `current` — all parts applied AND no gaps. This is the only conjunction R2 and R11 allow, so it is the
 *    only place the word appears.
 */
export function deriveGuildRegistryStatus(input: {
	readonly unavailable: boolean;
	readonly resyncInFlight: boolean;
	readonly pendingBootstrapParts: readonly string[];
	readonly openGaps: readonly RegistryGapRecord[];
}): GuildRegistryStatus {
	if (input.unavailable) {
		return "unavailable";
	}
	if (input.resyncInFlight) {
		return "stale";
	}
	if (input.pendingBootstrapParts.length > 0) {
		return "incomplete";
	}
	if (input.openGaps.length > 0) {
		return "stale";
	}
	return "current";
}

/** Gaps grouped by kind, with counts — the shape a readiness report and the anomaly counters both consume. */
export function gapCountsByKind(gaps: readonly RegistryGapRecord[]): Partial<Record<RegistryGapKind, number>> {
	const counts: Partial<Record<RegistryGapKind, number>> = {};
	for (const gap of gaps) {
		counts[gap.kind] = (counts[gap.kind] ?? 0) + 1;
	}
	return counts;
}

/** Anomaly counts for the whole ledger: every known reason present, so a report never has a moving shape. */
export function completeAnomalyCounts(
	counts: Readonly<Partial<Record<GuildStateAnomalyReason, number>>>
): Readonly<Record<GuildStateAnomalyReason, number>> {
	const complete: Record<GuildStateAnomalyReason, number> = {
		"foreign-guild": 0,
		"incomplete-role-description": 0,
		"payload-carried-no-overwrite-set": 0,
		"unknown-thread-membership": 0,
		"roster-truncated": 0,
		"thread-member-list-unreadable": 0,
		"targeted-read-failed": 0,
		"guild-unavailable": 0
	};
	for (const reason of GUILD_STATE_ANOMALY_REASONS) {
		complete[reason] = counts[reason] ?? 0;
	}
	return complete;
}

export function initialResyncState(guildId: DiscordIdentifier): GuildResyncStateSnapshot {
	return {
		guildId,
		resyncInFlight: false,
		resyncEpoch: null,
		convergedEpoch: null,
		unavailable: false,
		unavailableReason: null,
		openGaps: Object.freeze([]),
		anomalyCounts: Object.freeze({})
	};
}
