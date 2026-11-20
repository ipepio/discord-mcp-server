import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	GuildBootstrapPart,
	GuildBootstrapStateSnapshot,
	GuildBootstrapStateTracker
} from "../models/domain/bootstrap-state.js";
import {
	GUILD_BOOTSTRAP_PARTS,
	bootstrapStateIsComplete,
	initialBootstrapState,
	withPartApplied
} from "../models/domain/bootstrap-state.js";

/**
 * The bootstrap-state tracker of one process (docs/features/guild-state.md R2).
 *
 * It is a Map, not a table. That is the recorded project decision for this task (odd/tasks/guild-state.md
 * T2): a part's state lives in memory, a process start begins with every part pending, and re-running the
 * pass is safe because every registry write in `repositories/` is keyed on Discord's own ids and replaces
 * wholesale — a replayed pass changes nothing observable (R9). So "resumable" is delivered by two halves:
 * within a process, a pass applies only what is still pending; across a restart, the fresh tracker makes the
 * next pass re-read everything and the converged rows simply stay converged.
 *
 * The durable status semantics — `current`/`incomplete`/`stale`/`unavailable` and the query that reports
 * them — are a later task (T8), which is why this class implements the
 * {@link GuildBootstrapStateTracker} contract and touches no repository: replacing it with a stored
 * implementation is a composition change, not a schema or persistence change.
 *
 * Nothing here awaits, retries or logs: it records what a pass achieved and answers one question honestly
 * (R2: completion is never claimed while a part is pending).
 */
export class InMemoryBootstrapStateTracker implements GuildBootstrapStateTracker {
	private state: GuildBootstrapStateSnapshot;

	public constructor(deps: { readonly guildId: DiscordIdentifier }) {
		this.state = initialBootstrapState(deps.guildId);
	}

	public get guildId(): DiscordIdentifier {
		return this.state.guildId;
	}

	public readonly snapshot = (): GuildBootstrapStateSnapshot => this.state;

	public readonly pendingParts = (): readonly GuildBootstrapPart[] =>
		GUILD_BOOTSTRAP_PARTS.filter((part) => this.state.parts[part] !== "applied");

	public readonly isApplied = (part: GuildBootstrapPart): boolean => this.state.parts[part] === "applied";

	/** Recording an applied part is idempotent, so a pass that re-applies a part cannot corrupt the state. */
	public readonly markApplied = (part: GuildBootstrapPart): void => {
		this.state = withPartApplied(this.state, part);
	};

	/** R11's resync entry point: forget the applied parts so the next bootstrap pass re-reads everything. */
	public readonly reset = (): void => {
		this.state = initialBootstrapState(this.state.guildId);
	};

	public readonly isComplete = (): boolean => bootstrapStateIsComplete(this.state);
}
