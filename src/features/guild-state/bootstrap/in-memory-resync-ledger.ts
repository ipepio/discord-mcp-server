import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	GuildResyncStateLedger,
	GuildResyncStateSnapshot,
	GuildStateAnomalyReason,
	RegistryGapKind,
	RegistryGapRecord
} from "../models/domain/resync-state.js";
import { completeAnomalyCounts, initialResyncState, registryGapKey } from "../models/domain/resync-state.js";

/**
 * The resync ledger of one process (docs/features/guild-state.md R11; the status half of R2).
 *
 * It sits beside {@link InMemoryBootstrapStateTracker} and follows the same recorded decision
 * (`odd/tasks/guild-state.md` T2): this state is in memory per process, not a table. A restart therefore
 * reports nothing in flight and nothing open, and that is not a lie — the fresh process has applied nothing,
 * so its bootstrap parts are all pending and the status is `incomplete` before any gap could matter; the
 * first `resync-needed` signal re-converges the registry (R5 + R11) and the idempotent writes make that
 * re-run free (R9).
 *
 * The three facts it keeps are exactly the ones the status rules consume: in flight, open gaps, unavailable.
 * Gap recording is keyed on kind plus resource, so a replayed anomaly report changes nothing observable (R9),
 * and a gap is only removed by the caller that proved it closed — never by optimism, which is what R11's
 * "never marks the registry current on a partial read" forbids.
 */
export class InMemoryGuildResyncLedger implements GuildResyncStateLedger {
	private state: GuildResyncStateSnapshot;

	public constructor(deps: { readonly guildId: DiscordIdentifier }) {
		this.state = initialResyncState(deps.guildId);
	}

	public get guildId(): DiscordIdentifier {
		return this.state.guildId;
	}

	public readonly snapshot = (): GuildResyncStateSnapshot => this.state;

	public readonly beginResync = (epoch: number): void => {
		this.state = {
			...this.state,
			resyncInFlight: true,
			resyncEpoch: Number.isInteger(epoch) ? epoch : null
		};
	};

	public readonly endResync = (convergedEpoch?: number): void => {
		this.state = {
			...this.state,
			resyncInFlight: false,
			resyncEpoch: null,
			// The highest epoch served, so an older or replayed signal can be recognised as inert (R9).
			convergedEpoch:
				convergedEpoch === undefined || !Number.isInteger(convergedEpoch)
					? this.state.convergedEpoch
					: Math.max(this.state.convergedEpoch ?? 0, convergedEpoch)
		};
	};

	public readonly markUnavailable = (reason: GuildStateAnomalyReason): void => {
		this.state = { ...this.state, unavailable: true, unavailableReason: reason };
		this.countAnomaly(reason);
	};

	public readonly markAvailable = (): void => {
		this.state = { ...this.state, unavailable: false, unavailableReason: null };
	};

	public readonly recordGap = (gap: RegistryGapRecord): void => {
		const key = registryGapKey(gap);
		const current = this.state.openGaps;
		const index = current.findIndex((candidate) => registryGapKey(candidate) === key);
		// A new gap is appended; a re-reported one replaces its record in place, so the count never inflates (R9).
		const next =
			index === -1 ? [...current, gap] : current.map((candidate, at) => (at === index ? gap : candidate));
		this.state = { ...this.state, openGaps: Object.freeze(next) };
	};

	public readonly resolveGap = (kind: RegistryGapKind, resourceId: DiscordIdentifier): boolean => {
		const key = `${kind}:${resourceId}`;
		const kept = this.state.openGaps.filter((candidate) => registryGapKey(candidate) !== key);
		if (kept.length === this.state.openGaps.length) {
			return false;
		}
		this.state = { ...this.state, openGaps: Object.freeze(kept) };
		return true;
	};

	public readonly gapsOf = (kind: RegistryGapKind): readonly RegistryGapRecord[] =>
		this.state.openGaps.filter((gap) => gap.kind === kind);

	public readonly countAnomaly = (reason: GuildStateAnomalyReason, by = 1): void => {
		this.state = {
			...this.state,
			anomalyCounts: Object.freeze(
				completeAnomalyCounts({
					...this.state.anomalyCounts,
					[reason]: (this.state.anomalyCounts[reason] ?? 0) + by
				})
			)
		};
	};
}
