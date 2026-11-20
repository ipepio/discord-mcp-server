import { DISCORD_EVENT_KINDS, type DiscordEventKind } from "./discord-event-kind.enum.js";

/**
 * Declared gaps (spec R4, R5, R6). "Gap" means any interval in which inbound events may not have
 * been delivered. Every gap is recorded here so the next transition into a connected state can name
 * it inside the `resync-needed` signal: a gap is never silent, and nothing here survives a restart
 * (R10) — a fresh process simply declares an unscoped gap by publishing its first signal (R5).
 */
export type DeclaredGapReason = "drain-expiry" | "intake-stopped" | "dropped-delivery";

export interface DeclaredGap {
	readonly reason: DeclaredGapReason;
	/** The kinds this gap narrows to; an empty list means the scope is unknown. */
	readonly affectedKinds: readonly DiscordEventKind[];
	readonly undeliveredCount: number;
	readonly declaredInstant: Date;
}

/** What the next `resync-needed` signal should say about everything recorded so far. */
export interface GapSummary {
	/** True when the pending gaps name specific kinds; false means "resynchronize everything". */
	readonly narrowed: boolean;
	readonly affectedKinds: readonly DiscordEventKind[];
	readonly undeliveredCount: number;
}

const UNSCOPED: GapSummary = Object.freeze({ narrowed: false, affectedKinds: [], undeliveredCount: 0 });

export class DiscordDeclaredGaps {
	private readonly gaps: DeclaredGap[] = [];

	public record(gap: DeclaredGap): void {
		this.gaps.push(gap);
	}

	public pending(): readonly DeclaredGap[] {
		return Object.freeze([...this.gaps]);
	}

	/**
	 * Merges every pending gap and clears the ledger: one signal summarizes the whole interval, not
	 * one per gap or per failed attempt (R5 boundary).
	 */
	public consumeSummary(): GapSummary {
		if (this.gaps.length === 0) {
			return UNSCOPED;
		}

		const kinds = new Set<DiscordEventKind>();
		let undeliveredCount = 0;
		let narrowed = true;

		for (const gap of this.gaps) {
			undeliveredCount += gap.undeliveredCount;
			if (gap.affectedKinds.length === 0) {
				narrowed = false;
				continue;
			}

			for (const kind of gap.affectedKinds) {
				kinds.add(kind);
			}
		}

		this.gaps.length = 0;

		// A gap covering every kind is no narrower than an unscoped one.
		if (narrowed && kinds.size < DISCORD_EVENT_KINDS.length) {
			return { narrowed: true, affectedKinds: Object.freeze([...kinds]), undeliveredCount };
		}

		return { narrowed: false, affectedKinds: Object.freeze(DISCORD_EVENT_KINDS), undeliveredCount };
	}
}
