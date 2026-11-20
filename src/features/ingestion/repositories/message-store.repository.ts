import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	ChannelExclusionResult,
	ChannelMessageExclusion,
	MessageBatchWriteResult,
	MessageEditWrite,
	MessageEditWriteResult,
	MessageTombstoneResult,
	MessageTombstoneWrite,
	MessageWrite,
	StoredMessage
} from "../models/domain/message-records.js";

/**
 * The message store: the contract ingestion owns for `message` and `message_attachment`
 * (docs/features/ingestion.md R4 to R8, R11; ADR-0007; docs/architecture/persistence.md).
 *
 * One contract covers both tables because attachments have no lifecycle of their own: they are written,
 * replaced and removed with the message that carries them, and R6's tombstone drops them in the same
 * transaction that drops the content. Splitting them would force every caller to know the pairing.
 *
 * What is deliberately NOT here:
 *
 * - **No cross-feature reference.** No method names a channel registry row, a guild row or another
 *   feature's table: a message row is guild-scoped by its own `guild_id` column and bounded by the commands
 *   that refuse a foreign Guild before any statement runs (R1). The ids a bulk exclusion sweeps are resolved
 *   from the registry by the caller, which owns that lookup (R6, T5).
 * - **No deletion of message rows.** R6 and ADR-0007 make a tombstone terminal, so the store keeps the row
 *   for synchronization idempotency and drops only its content and attachment metadata.
 * - **No unbounded read.** The only read is the point read by message id, which the edit path needs to
 *   classify a refusal and reconcile a partial payload. The query feature owns every list read; its
 *   predicates do not exist yet, so no speculative list method is offered here.
 */
export interface MessageStoreRepository {
	/**
	 * R4 with R7: create or replace whole-message rows in bounded batches, one transaction per batch,
	 * idempotent on the Discord message id. An attachment set is replaced only for a message whose payload
	 * reported one, and only when the guarded write actually wrote — a refused stale backfill record cannot
	 * widen or narrow the newer attachment set. `attachmentsWritten` and `attachmentsRemoved` are the
	 * observable counts of that replacement (R11, R14).
	 */
	readonly upsertMessages: (messages: readonly MessageWrite[]) => Promise<MessageBatchWriteResult>;

	/**
	 * R6's exclusion made structural: the point read every later read path can be built on. A tombstoned row
	 * comes back as an id with no content and no attachments, because the content is physically gone; the
	 * row is returned rather than hidden so a caller can tell "deleted" from "never ingested" and never serve
	 * deleted text by accident.
	 */
	readonly findMessage: (guildId: DiscordIdentifier, messageId: DiscordIdentifier) => Promise<StoredMessage | null>;

	/**
	 * R5 with R8: replace one message's content and edited instant, guarded in the statement itself so an
	 * incoming state that is older than, or identical to, what is stored changes nothing. The guard is in SQL
	 * rather than only in the caller because two deliveries of one replay can run concurrently, and a
	 * read-then-write cannot settle that. The status names which guard fired.
	 */
	readonly applyMessageEdit: (edit: MessageEditWrite) => Promise<MessageEditWriteResult>;

	/**
	 * R6, single and bulk deletion: tombstone the named ids in bounded batches, one transaction per batch,
	 * dropping content and attachment metadata with them. Already-tombstoned rows keep their first
	 * `deleted_at` and are reported separately, and ids with no row are counted and named rather than
	 * invented into existence (R7).
	 */
	readonly tombstoneMessages: (tombstone: MessageTombstoneWrite) => Promise<MessageTombstoneResult>;

	/**
	 * R6's bulk half: tombstone every live message of the named channel and thread ids, sweeping bounded
	 * pages in one transaction each until a page comes back empty. Progress is structural — a swept row
	 * stops matching the page predicate — so the count is the whole story of what the exclusion covered.
	 */
	readonly excludeChannelMessages: (exclusion: ChannelMessageExclusion) => Promise<ChannelExclusionResult>;
}
