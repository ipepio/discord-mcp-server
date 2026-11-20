import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { GUILD_BOOTSTRAP_PARTS } from "../models/domain/bootstrap-state.js";
import type { GuildBootstrapPart, GuildBootstrapStateTracker } from "../models/domain/bootstrap-state.js";
import type {
	GuildRegistryStatus,
	GuildResyncStateLedger,
	GuildStateAnomalyReason,
	RegistryGapKind,
	RegistryGapRecord
} from "../models/domain/resync-state.js";
import { completeAnomalyCounts, deriveGuildRegistryStatus, gapCountsByKind } from "../models/domain/resync-state.js";
import type { GuildRegistryRepository } from "../repositories/guild-registry.repository.js";

/**
 * `GetGuildStateStatusQuery` — the durable status semantics the T2 decision deferred to this task
 * (docs/features/guild-state.md R2 and R11; Contracts: "bootstrap/resync completeness and staleness, for
 * readiness reporting and for the authorization feature's own gating policy").
 *
 * The answer is derived, never stored: the bootstrap tracker says which parts this process has applied, the
 * resync ledger says whether a resync is in flight, whether the Guild was lost and which gaps remain open, and
 * the Guild row says whether there is a registry at all. `deriveGuildRegistryStatus` is the one place the four
 * statuses are ordered, shared with `ResyncGuildStateCommand` so the command's result and this query can never
 * disagree about the same instant.
 *
 * The rules the derivation encodes:
 *
 * - R2: "Bootstrap completion is never claimed while any part is pending", and "a partially applied bootstrap
 *   keeps the status `incomplete` and is therefore never consumed as authoritative".
 * - R11: "While a resync is in flight the registry reports the stale/incomplete status", and a resync that
 *   cannot complete "leaves the status stale … never marks the registry current on a partial read". So an open
 *   gap — a refused role description, a `pendingRestFields: ["permissionOverwrites"]` channel, a truncated
 *   roster, an unreadable thread member list, an unknown-thread deferral (O1) — holds the status `stale` for as
 *   long as it is open, however complete the part list looks.
 * - R1's boundary and R2's error case: a Guild this Installation can no longer read makes the status
 *   `unavailable`, which outranks a fully converged part list, because rows about a Guild the bot may not see
 *   are not a permission authority.
 * - `current` only when all parts are applied AND nothing is open. That conjunction is the whole of R11's
 *   safety property, and this query is the only surface that states it.
 *
 * The anomaly counts are the R3/R5/R7/R8 refusal and deferral outcomes T3–T6 report, counted by reason. They
 * are part of the answer, not a side channel: a readiness report that said `stale` without naming why would
 * push an operator to guess (R14: ids, counts and reasons only — never a payload).
 *
 * Read-only (R13): one projection read, no write, no REST call, and no clock — the status is a fact about this
 * process's convergence, not a time window, which is also R12's "no TTL cache exists" kept honest.
 */

/** The part-level half of the answer: what the bootstrap owes and what this process has applied. */
export interface GuildStateBootstrapStatus {
	readonly complete: boolean;
	readonly pendingParts: readonly GuildBootstrapPart[];
	readonly appliedParts: readonly GuildBootstrapPart[];
}

/** The gap half: the open gaps themselves plus the counts a report needs. */
export interface GuildStateGapStatus {
	readonly openGaps: readonly RegistryGapRecord[];
	readonly gapCounts: Partial<Record<RegistryGapKind, number>>;
	readonly openGapCount: number;
	/** Field names still without a source, across the gaps that report fields (T3's roles, T5's overwrites). */
	readonly pendingRestFieldCount: number;
}

export interface GuildStateStatusResult {
	readonly guildId: DiscordIdentifier;
	readonly status: GuildRegistryStatus;
	/** True only when the registry row for the configured Guild exists (R2: the first thing a pass writes). */
	readonly guildRegistered: boolean;
	readonly bootstrap: GuildStateBootstrapStatus;
	readonly resync: {
		readonly inFlight: boolean;
		/** The epoch being served, while one is. */
		readonly epoch: number | null;
		/** The highest epoch fully converged; `null` before the first completed resync. */
		readonly convergedEpoch: number | null;
	};
	readonly gaps: GuildStateGapStatus;
	readonly anomalyCounts: Readonly<Record<GuildStateAnomalyReason, number>>;
	/** Present exactly when `status` is `unavailable`, with the reason the read failed (R2, R14). */
	readonly unavailableReason: GuildStateAnomalyReason | null;
}

/** The query has no input: it reports the one Guild this Installation serves (R1), which is never caller-supplied. */
export interface GetGuildStateStatusQueryDeps {
	readonly config: GuildStateConfig;
	readonly tracker: GuildBootstrapStateTracker;
	readonly ledger: GuildResyncStateLedger;
	readonly guildRegistry: GuildRegistryRepository;
	readonly logger: AppLogger;
}

export class GetGuildStateStatusQuery {
	private readonly guildId: DiscordIdentifier;

	private readonly tracker: GuildBootstrapStateTracker;

	private readonly ledger: GuildResyncStateLedger;

	private readonly guildRegistry: GuildRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: GetGuildStateStatusQueryDeps) {
		this.guildId = deps.config.guildId;
		this.tracker = deps.tracker;
		this.ledger = deps.ledger;
		this.guildRegistry = deps.guildRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (): Promise<GuildStateStatusResult> => {
		const resync = this.ledger.snapshot();
		const pendingParts = this.tracker.pendingParts();
		const parts = this.tracker.snapshot().parts;
		const appliedParts = GUILD_BOOTSTRAP_PARTS.filter((part) => parts[part] === "applied");
		const openGaps = resync.openGaps;
		const status = deriveGuildRegistryStatus({
			unavailable: resync.unavailable,
			resyncInFlight: resync.resyncInFlight,
			pendingBootstrapParts: pendingParts,
			openGaps
		});

		// R2's error case is stated from the registry, not only from the ledger: a Guild row that is not there
		// means nothing has been bootstrapped, which is `incomplete`, and never an empty-but-"current" answer.
		const guildRegistered = (await this.guildRegistry.findGuild(this.guildId)) !== null;

		const result: GuildStateStatusResult = {
			guildId: this.guildId,
			status,
			guildRegistered,
			bootstrap: {
				complete: this.tracker.isComplete(),
				pendingParts,
				appliedParts
			},
			resync: {
				inFlight: resync.resyncInFlight,
				epoch: resync.resyncEpoch,
				convergedEpoch: resync.convergedEpoch
			},
			gaps: {
				openGaps,
				gapCounts: gapCountsByKind(openGaps),
				openGapCount: openGaps.length,
				pendingRestFieldCount: openGaps.reduce((total, gap) => total + (gap.pendingFields?.length ?? 0), 0)
			},
			anomalyCounts: completeAnomalyCounts(resync.anomalyCounts),
			unavailableReason: resync.unavailable ? resync.unavailableReason : null
		};

		this.logger.debug("guild-state registry status read", {
			guildId: this.guildId,
			status: result.status,
			pendingPartCount: pendingParts.length,
			openGapCount: openGaps.length,
			resyncInFlight: resync.resyncInFlight,
			...(resync.unavailableReason === null ? {} : { unavailableReason: resync.unavailableReason })
		});

		return result;
	};
}
