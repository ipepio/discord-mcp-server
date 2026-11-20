import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { RegistryPermissionSnapshot } from "../models/domain/registry-records.js";

/**
 * The one read model permission evaluation is allowed to use (docs/features/guild-state.md R12;
 * docs/adr/0005: "the evaluation reads its inputs … from one consistent snapshot"; Contracts: "the read path
 * is one consistent snapshot — one joined query or one read transaction").
 *
 * Why this contract exists next to the T1 projections rather than as calls to them, recorded because it is
 * the one deliberate duplication in the feature:
 *
 * - The T1 projections are correct, individual reads, and each runs as its own statement on the pool. A
 *   base read, then an overwrite read, then a membership read is *three* snapshots with three independent
 *   commit points between them, and the state they describe can differ. That is the torn read ADR 0005
 *   rejected, and it is rejected here rather than assumed away: every statement below runs inside one read
 *   transaction taken at `REPEATABLE READ`, so the whole projection is one instant of the registry.
 * - A caller-supplied session would mean changing the T1 contracts, which the event-application commands
 *   already depend on. A combined read is the smaller change and the one the spec names first ("one read
 *   transaction").
 * - `ListUserAccessibleChannelsQuery` and `ListIngestibleChannelsQuery` need every channel and every
 *   overwrite set of the Guild at once, which is exactly the "one bounded set read, never a loop of
 *   per-thread calls" that the Contracts section demands. The narrow projection serves them too, but a loop
 *   of point reads would not be one snapshot, so the wide form is the honest shape.
 *
 * Nothing here writes. That is not a convention but a type: the interface has one method and it returns
 * rows (R13's read-only purity, enforced by the contract a caller can inject).
 */
export interface PermissionSnapshotRequest {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	/**
	 * The channel one evaluation targets, which narrows the read to that channel and the parent its thread
	 * names. `null` is the wide form: every stored channel and every stored overwrite set of the Guild, in
	 * the registry's own deterministic order, for a single bounded pass over the whole registry.
	 */
	readonly channelId: DiscordIdentifier | null;
}

export interface PermissionSnapshotRepository {
	/** One read transaction, one snapshot, the whole projection. No partial result is ever returned. */
	readonly loadSnapshot: (request: PermissionSnapshotRequest) => Promise<RegistryPermissionSnapshot>;
}
