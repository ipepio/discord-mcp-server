import { DiscordRestFailureError, DiscordRestOperation } from "../../../../src/features/discord/index.js";
import type {
	DiscordMessageRecord,
	DiscordRestFailureDetails,
	DiscordRestFailureReason,
	MessageAttachmentMetadata
} from "../../../../src/features/discord/index.js";
import type {
	MessageReconciliationRead,
	MessageRestGateway
} from "../../../../src/features/ingestion/gateways/message-rest-gateway.interface.js";
import {
	ATTACHMENT_ID,
	AUTHOR_ID,
	CHANNEL_ID,
	CREATED_AT,
	EDITED_AT,
	MESSAGE_ID,
	SECRET_CONTENT,
	SECRET_FILENAME,
	SECRET_URL,
	SECRET_USERNAME
} from "./message-fixtures.js";

/**
 * The `MessageRestGateway` double R5's reconciliation is tested against (docs/architecture/testing.md:
 * "Gateway tests — outgoing contract, external failures and response validation", and the same seam replaces a
 * gateway in a use-case test).
 *
 * It answers with the discord boundary's own application type, `DiscordMessageRecord`, and fails with the
 * boundary's own error, `DiscordRestFailureError`, because the command's behaviour turns on that failure
 * classification: a `not-found`, a `timeout` and a `validation` refusal are three different reasons in the
 * deferred outcome, and a faked error shape would let a test pass against a failure the real adapter can never
 * produce. `tests/features/discord/gateways/discord-rest.gateway.test.ts` is where the boundary itself is
 * proven; nothing here claims to prove it.
 *
 * Every call is recorded with both ids it was addressed by, so a test can assert the two bounds R5 implies: a
 * complete edit asks for nothing, and a partial edit asks exactly once for the message it named.
 */
export class FakeMessageRestGateway implements MessageRestGateway {
	public readonly calls: MessageReconciliationRead[] = [];

	/** The answer the read gives when its queue is empty. `null` means "this seam has nothing to say". */
	public record: DiscordMessageRecord | null = null;

	/** Set to make every read fail with this boundary failure instead of answering. */
	public failure: DiscordRestFailureDetails | null = null;

	/** Programmed answers in order, for a test that reconciles more than one event. */
	public readonly answers: DiscordMessageRecord[] = [];

	public readonly readMessage = async (read: MessageReconciliationRead): Promise<DiscordMessageRecord> => {
		this.calls.push({ ...read });

		if (this.failure !== null) {
			throw new DiscordRestFailureError(this.failure);
		}

		const next = this.answers.shift() ?? this.record;
		if (next === null) {
			throw new DiscordRestFailureError({
				operation: DiscordRestOperation.message,
				reason: "not-found",
				attempts: 1,
				detail: "the fake reconciliation seam has no message programmed"
			});
		}

		return next;
	};

	/** How many times the seam was asked, in call order. */
	public addressed(): readonly (readonly [string, string])[] {
		return this.calls.map((call) => [call.channelId, call.messageId] as const);
	}

	/** Fails the next reads with one boundary reason, as the adapter would report it. */
	public failWith(
		reason: DiscordRestFailureReason,
		overrides: Partial<Omit<DiscordRestFailureDetails, "reason">> = {}
	): this {
		this.failure = {
			operation: DiscordRestOperation.message,
			reason,
			attempts: 1,
			detail: `fake reconciliation read failed (${reason})`,
			...overrides
		};
		return this;
	}

	/** Fails with a validation refusal naming the field path, the shape R7's error bullet describes. */
	public failValidation(fieldPath: string): this {
		return this.failWith("validation", { fieldPath });
	}
}

/** Attachment metadata as the discord boundary reports it: `contentType` absent rather than empty (R11 there). */
export function reconciliationAttachment(
	attachmentId: string = ATTACHMENT_ID,
	overrides: Partial<MessageAttachmentMetadata> = {}
): MessageAttachmentMetadata {
	return {
		attachmentId,
		filename: SECRET_FILENAME,
		url: SECRET_URL,
		sizeBytes: 1_048_576,
		contentType: "application/pdf",
		...overrides
	};
}

/**
 * One whole message as `readMessage` answers with. Content and instants are the fixture secrets, so the same
 * R12 scan that covers the event path covers the reconciled path.
 */
export function reconciliationRecord(overrides: Partial<DiscordMessageRecord> = {}): DiscordMessageRecord {
	return {
		messageId: MESSAGE_ID,
		channelId: CHANNEL_ID,
		authorId: AUTHOR_ID,
		authorUsername: SECRET_USERNAME,
		content: SECRET_CONTENT,
		createdInstant: CREATED_AT,
		editedInstant: EDITED_AT,
		messageType: "default",
		...overrides
	};
}
