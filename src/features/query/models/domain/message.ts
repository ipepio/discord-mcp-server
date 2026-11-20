export interface AttachmentMetadata {
	readonly attachmentId: string;
	readonly filename: string;
	readonly contentType: string | null;
	readonly sizeBytes: number;
	readonly url: string;
}

/** Stored projection; registry provenance is attached by the use case, never read from registry tables. */
export interface StoredMessage {
	readonly messageId: string;
	readonly guildId: string;
	readonly channelId: string;
	readonly authorId: string;
	readonly authorDisplayName: string | null;
	readonly createdAt: string;
	readonly editedAt: string | null;
	readonly messageType: string;
	readonly replyToMessageId: string | null;
	readonly content: string;
	readonly contentLength: number;
	readonly attachments: readonly AttachmentMetadata[];
}

export interface MessageKey {
	readonly createdAt: string;
	readonly messageId: string;
}
