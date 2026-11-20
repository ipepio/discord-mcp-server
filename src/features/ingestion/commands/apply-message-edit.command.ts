import { DiscordRestFailureError } from "../../discord/index.js";
import type { DiscordMessageRecord, DiscordRestFailureReason, NormalizedMessageType } from "../../discord/index.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { MessageRestGateway } from "../gateways/message-rest-gateway.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { MessageEditWrite } from "../models/domain/message-records.js";
import type { MessageEditField } from "../models/domain/message-rules.js";
import { editAssertsNothing, isForeignGuildRecord, missingEditFields } from "../models/domain/message-rules.js";
import { toReportedAttachments } from "../models/mappers/message-event.mapper.js";
import type { MessageStoreRepository } from "../repositories/message-store.repository.js";

/**
 * `MESSAGE_UPDATE` applied to the message store (docs/features/ingestion.md R5, with R7, R8, R10, R11, R12;
 * ADR-0007).
 *
 * The rule has three parts, and this command is where each is decided:
 *
 * - **A payload that asserts nothing is not an edit.** A flags or pin change carries neither new text nor an
 *   edit instant; the mirror has no content rule to apply to it, and reconciling it would spend a rate-limited
 *   read to write nothing (R5, R7).
 * - **A complete update is written directly.** Content and an edited instant both present means the payload
 *   already states the whole state the mirror has to hold, so it goes through the repository's guarded edit
 *   with no read at all — which is what keeps an ordinary edit from costing a request.
 * - **A partial update is reconciled first** (R5: "Updates that arrive without full fields are reconciled by
 *   fetching the message via REST before overwriting"). The read is the discord adapter's `readMessage`: one
 *   request for one message, never a page scan (`odd/tasks/ingestion.md` T2). The edit written is then the
 *   *completed* state: a field the event carried keeps the event's value — the event is the newer observation,
 *   and a read that answers after it must not restore an older revision — and a field it did not carry takes
 *   the value the read reported. Nothing is invented: a read that reported no attachment list leaves the stored
 *   set exactly as it is, which is the store's own form of "not reported" (R10, R11).
 * - **A reconciliation that cannot be had defers the update.** A timeout, a rate limit that outlasted the
 *   adapter's budget, a 4xx or a payload that failed validation all leave the stored content exactly where it
 *   was and return `deferred` with the boundary's own reason. Writing the half-state the event carried would be
 *   inventing fields; dropping the event without saying so would be losing an edit. Neither is what R5 says.
 *
 * R5's other half — "an update carrying an edit timestamp older than the stored one does not regress the
 * content" — is decided by the store's guard, not here, and reported as `refused: stale`. The same refusal
 * covers a replay (`unchanged`), a tombstone (`tombstoned`) and a message that was never ingested (`absent`),
 * and none of them writes: the guard is in the statement, so two concurrent deliveries of one replay settle
 * the same way (docs/architecture/persistence.md).
 *
 * R12: ids, counts, field names and reasons reach the log. Message text does not — not as a field, not inside a
 * reason, and not in the deferred path, where the failure is named by its boundary reason, status and field
 * path only.
 */

/**
 * One message update, as a normalized `MESSAGE_UPDATE` payload describes it. Absent is the whole story of the
 * partial case: it is precisely what makes a reconciliation necessary.
 */
export interface ApplyMessageEditEvent {
	/** The Guild the event came from. Anything other than the configured one is refused (R1). */
	readonly guildId: DiscordIdentifier;
	readonly messageId: DiscordIdentifier;
	/**
	 * The container Discord named, required because that is how a message is addressed: the reconciliation is
	 * `GET /channels/{channel.id}/messages/{message.id}`, and a thread's message lives under the thread's id.
	 */
	readonly channelId: DiscordIdentifier;
	/** Absent when the payload carried no content — the field that makes the update partial (R5). */
	readonly content?: string;
	/** Absent when the payload carried no edited timestamp. */
	readonly editedInstant?: Date;
	/** Absent when the payload said nothing about the type; the stored type then stays (R5). */
	readonly messageType?: NormalizedMessageType;
}

/**
 * An update that states the whole state the mirror has to hold, so no read is needed to complete it. The
 * narrowing is `missingEditFields`, the domain rule, restated as a type predicate rather than re-implemented:
 * the code and the rule can therefore never disagree about which payloads count as complete (R5).
 */
interface CompleteMessageEditEvent extends ApplyMessageEditEvent {
	readonly content: string;
	readonly editedInstant: Date;
}

function isCompleteEdit(update: ApplyMessageEditEvent): update is CompleteMessageEditEvent {
	return missingEditFields(update).length === 0;
}

/** Why an update was not written. `stale` and `unchanged` are the two refusals that protect newer content. */
export type MessageEditRefusalReason = "nothing-asserted" | "stale" | "unchanged" | "tombstoned" | "absent";

/** Why a reconciliation could not be had, in the discord boundary's own vocabulary (docs/features/discord.md R7). */
export interface MessageEditReconcileFailure {
	readonly reason: DiscordRestFailureReason;
	readonly attempts: number;
	/** The HTTP status Discord answered with, or `null` when the request never produced one (timeout, transport). */
	readonly status: number | null;
	/** The offending path of a payload that failed validation, or `null` for every other failure (R7 error). */
	readonly fieldPath: string | null;
}

/** Where one message update ended up. Every case is reported, because a deferred edit is not a stored edit. */
export type ApplyMessageEditOutcome =
	| {
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly messageId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			/** True when the stored state came from a REST read rather than from the event alone (R5). */
			readonly reconciled: boolean;
			readonly storedEditedInstant: Date | null;
			readonly attachmentsWritten: number;
			readonly attachmentsRemoved: number;
	  }
	| {
			readonly status: "refused";
			readonly guildId: DiscordIdentifier;
			readonly messageId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly reason: MessageEditRefusalReason;
			readonly reconciled: boolean;
			/** What the store still holds as its edit instant, which is what the next comparison uses (R8). */
			readonly storedEditedInstant: Date | null;
	  }
	| {
			readonly status: "deferred";
			readonly guildId: DiscordIdentifier;
			readonly messageId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly reason: "reconcile-unavailable";
			/** The fields the event did not carry, and therefore the fields the update could not be completed from. */
			readonly missingFields: readonly MessageEditField[];
			readonly failure: MessageEditReconcileFailure;
	  }
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly messageId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface ApplyMessageEditCommandDeps {
	readonly config: IngestionConfig;
	readonly messageStore: MessageStoreRepository;
	readonly messageRest: MessageRestGateway;
	readonly logger: AppLogger;
}

/** What a reconciliation attempt produced: the message whole, or the boundary failure that stopped it. */
type Reconciliation =
	| { readonly completed: true; readonly record: DiscordMessageRecord }
	| { readonly completed: false; readonly failure: MessageEditReconcileFailure };

export class ApplyMessageEditCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly messageStore: MessageStoreRepository;

	private readonly messageRest: MessageRestGateway;

	private readonly logger: AppLogger;

	public constructor(deps: ApplyMessageEditCommandDeps) {
		this.guildId = deps.config.guildId;
		this.messageStore = deps.messageStore;
		this.messageRest = deps.messageRest;
		this.logger = deps.logger;
	}

	public readonly execute = async (event: ApplyMessageEditEvent): Promise<ApplyMessageEditOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			return this.dropForeignGuild(event.guildId, event.messageId, event.channelId);
		}

		const messageId = requireDiscordIdentifier("message.message_id", event.messageId);
		const channelId = requireDiscordIdentifier("message.channel_id", event.channelId);

		if (editAssertsNothing(event)) {
			return this.refuse(messageId, channelId, "nothing-asserted", false, null);
		}

		if (isCompleteEdit(event)) {
			return this.write(this.editFromEvent(event, messageId), channelId, false, 0);
		}

		const missing = missingEditFields(event);
		const reconciliation = await this.reconcile(messageId, channelId, missing);
		if (!reconciliation.completed) {
			return this.defer(messageId, channelId, missing, reconciliation.failure);
		}

		return this.write(this.editFromRead(event, messageId, reconciliation.record), channelId, true, missing.length);
	};

	/**
	 * One guarded write and the report of its decision. `reconciled` and `completedFieldCount` are facts about
	 * the payload, not about the row: they say how the state being written was arrived at, which is what a
	 * reviewer of a convergence defect reads first (R8, R12).
	 */
	private async write(
		edit: MessageEditWrite,
		channelId: DiscordIdentifier,
		reconciled: boolean,
		completedFieldCount: number
	): Promise<ApplyMessageEditOutcome> {
		const applied = await this.messageStore.applyMessageEdit(edit);
		const messageId = edit.messageId;

		if (applied.status !== "applied") {
			return this.refuse(messageId, channelId, applied.status, reconciled, applied.storedEditedInstant);
		}

		this.logger.info("ingestion applied a message edit", {
			guildId: this.guildId,
			messageId,
			channelId,
			reconciled,
			completedFieldCount,
			// The instant the store now compares the next update against, never the text it goes with (R12).
			storedEditedInstant: applied.storedEditedInstant?.toISOString() ?? null,
			attachmentsWritten: applied.attachmentsWritten,
			attachmentsRemoved: applied.attachmentsRemoved
		});

		return {
			status: "applied",
			guildId: this.guildId,
			messageId,
			channelId,
			reconciled,
			storedEditedInstant: applied.storedEditedInstant,
			attachmentsWritten: applied.attachmentsWritten,
			attachmentsRemoved: applied.attachmentsRemoved
		};
	}

	/** R1: named and counted, never written, and never read either — a foreign event cannot reach Discord here. */
	private dropForeignGuild(
		eventGuildId: DiscordIdentifier,
		messageId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): ApplyMessageEditOutcome {
		this.logger.warn("ingestion dropped a message edit for another guild", {
			guildId: this.guildId,
			eventGuildId,
			messageId,
			channelId,
			operation: "apply-message-edit"
		});
		return { status: "dropped", guildId: this.guildId, messageId, channelId, reason: "foreign-guild" };
	}

	/**
	 * R5's reconciliation: the message as Discord reports it now, or the boundary failure that stopped the read.
	 * Only a `DiscordRestFailureError` is caught — anything else is a defect in this command or in the seam, and
	 * a defect reported as a deferred edit would lose the event quietly (docs/architecture/shared.md: unexpected
	 * failures stay unexpected).
	 */
	private async reconcile(
		messageId: DiscordIdentifier,
		channelId: DiscordIdentifier,
		missing: readonly MessageEditField[]
	): Promise<Reconciliation> {
		try {
			return { completed: true, record: await this.messageRest.readMessage({ channelId, messageId }) };
		} catch (failure) {
			if (!(failure instanceof DiscordRestFailureError)) {
				throw failure;
			}

			const reported: MessageEditReconcileFailure = {
				reason: failure.reason,
				attempts: failure.attempts,
				status: failure.status ?? null,
				fieldPath: failure.fieldPath ?? null
			};

			this.logger.warn("ingestion deferred a message edit that could not be reconciled", {
				guildId: this.guildId,
				messageId,
				channelId,
				operation: failure.operation,
				missingFields: missing,
				reason: reported.reason,
				attempts: reported.attempts,
				status: reported.status,
				fieldPath: reported.fieldPath
			});

			return { completed: false, failure: reported };
		}
	}

	/** The complete payload as the store's edit record: an unreported type stays stored, and no set is reported. */
	private editFromEvent(event: CompleteMessageEditEvent, messageId: DiscordIdentifier): MessageEditWrite {
		return {
			guildId: this.guildId,
			messageId,
			content: event.content,
			editedInstant: event.editedInstant,
			messageType: event.messageType ?? null,
			// R10: an edit payload carries no attachment list, so the stored set is exactly what stays.
			attachments: null
		};
	}

	/**
	 * The state the event plus the read add up to (R5). The event's own values win where it had them: it is the
	 * newer observation, and a read answered after it must not restore what the author already replaced.
	 */
	private editFromRead(
		event: ApplyMessageEditEvent,
		messageId: DiscordIdentifier,
		record: DiscordMessageRecord
	): MessageEditWrite {
		return {
			guildId: this.guildId,
			messageId,
			content: event.content ?? record.content,
			// `null` is the honest form of "no edit instant is known", and the store's guard then reads a row that
			// already has one as newer — which is R8's late-record case, reached from a read this time.
			editedInstant: event.editedInstant ?? record.editedInstant ?? null,
			messageType: event.messageType ?? record.messageType ?? null,
			// Only the read can report a set, and only when it reported one (R10, R11).
			attachments: toReportedAttachments(record.attachments)
		};
	}

	private refuse(
		messageId: DiscordIdentifier,
		channelId: DiscordIdentifier,
		reason: MessageEditRefusalReason,
		reconciled: boolean,
		storedEditedInstant: Date | null
	): ApplyMessageEditOutcome {
		this.logger.warn("ingestion refused a message edit", {
			guildId: this.guildId,
			messageId,
			channelId,
			reason,
			reconciled,
			// The instant the store still relies on, never the text it belongs to (R12).
			storedEditedInstant: storedEditedInstant?.toISOString() ?? null
		});
		return {
			status: "refused",
			guildId: this.guildId,
			messageId,
			channelId,
			reason,
			reconciled,
			storedEditedInstant
		};
	}

	/** R5's error behaviour: the update goes back to the caller unwritten, with the reason the boundary gave. */
	private defer(
		messageId: DiscordIdentifier,
		channelId: DiscordIdentifier,
		missingFields: readonly MessageEditField[],
		failure: MessageEditReconcileFailure
	): ApplyMessageEditOutcome {
		return {
			status: "deferred",
			guildId: this.guildId,
			messageId,
			channelId,
			reason: "reconcile-unavailable",
			missingFields,
			failure
		};
	}
}
