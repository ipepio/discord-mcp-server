import { describe, expect, it } from "vitest";
import { PostgresMessageStoreRepository } from "../../../src/features/ingestion/repositories/postgres-message-store.repository.js";
import {
	CHANNEL_ID,
	CREATED_AT,
	DELETED_AT,
	EDITED_AT,
	GUILD_ID,
	LATER_EDIT_AT,
	MESSAGE_ID,
	SECRET_CONTENT,
	SECRET_URL,
	attachment,
	attachmentRow,
	messageRow,
	messageWrite,
	storedMessage,
	tombstoneWrite
} from "./fakes/message-fixtures.js";
import { RecordingSqlExecutor } from "./fakes/recording-sql-executor.js";

/**
 * What the PostgreSQL adapter asks the database to do, proven without a server (docs/architecture/testing.md:
 * the doubles prove call shape; the integration suite proves SQL behaviour). The claims that belong here are
 * the ones a database answers only expensively:
 *
 * - **Every value is a bound parameter.** Ids, text, timestamps and whole arrays of a batch reach PostgreSQL as
 *   `$n` parameters, and no id ever appears in statement text (docs/architecture/persistence.md: "Parameterize
 *   all SQL. Do not build dynamic identifiers or WHERE fragments from user-controlled strings"). The only
 *   numbers that appear literally in the text are the column arrays' declared types and the exclusion page's
 *   `LIMIT $3`.
 * - **The convergence guards are in the statements**, not only in the caller, so a concurrent replay of the
 *   same event cannot settle into a regression (persistence.md: "a pre-insert lookup cannot guarantee …
 *   under concurrency"). A unit test can read those clauses; the integration suite proves they hold.
 * - **A write that reports nothing is distinguishable from a write that changed nothing**, which is what R7 and
 *   R14's observable counts rest on: the adapter counts rows out of `RETURNING`, never a driver count.
 * - **One batch is one transaction**, bounded by the configured size, and the bulk sweep is one transaction per
 *   page (persistence.md's bound-before-execution rule).
 */

const UPSERT_MARKER = "INSERT INTO message\n";
const EDIT_MARKER = "UPDATE message AS m";
const TOMBSTONE_MARKER = "SET content = NULL";
const ATTACHMENT_SWEEP_MARKER = "DELETE FROM message_attachment";
const ATTACHMENT_INSERT_MARKER = "INSERT INTO message_attachment";
const FIND_MARKER = "FROM message\n\tWHERE guild_id = $1 AND message_id = $2";

function subject(
	executor = new RecordingSqlExecutor(),
	bounds: { writeBatchSize?: number; exclusionPageSize?: number } = {}
): { repository: PostgresMessageStoreRepository; executor: RecordingSqlExecutor } {
	return {
		repository: new PostgresMessageStoreRepository({
			executor,
			writeBatchSize: bounds.writeBatchSize ?? 200,
			exclusionPageSize: bounds.exclusionPageSize ?? 2
		}),
		executor
	};
}

describe("message store adapter — the whole-row write (R4 with R7, R8)", () => {
	it("writes one batch as one transaction of bound parameters and nothing interpolated", async () => {
		const h = subject();
		h.executor.reply(UPSERT_MARKER, [{ message_id: MESSAGE_ID }]);
		h.executor.reply(ATTACHMENT_SWEEP_MARKER, []);

		const written = await h.repository.upsertMessages([
			messageWrite({
				authorUsername: null,
				attachments: [attachment()],
				replyReference: { messageId: "160000000000000402", channelId: null, guildId: null }
			})
		]);

		expect(written.rowsWritten).toBe(1);
		expect(h.executor.transactions).toBe(1);
		const statement = h.executor.matching(UPSERT_MARKER)[0];
		expect(statement?.via).toBe("session");
		expect(statement?.parameters).toHaveLength(14);
		// The id columns are bound as the strings the identifier guard accepted, never as numbers.
		expect(statement?.parameters?.[0]).toEqual([MESSAGE_ID]);
		expect(statement?.parameters?.[1]).toEqual([GUILD_ID]);
		expect(statement?.parameters?.[9]).toEqual([CREATED_AT]);
		expect(statement?.parameters?.[10]).toEqual([null]);
		expect(statement?.statement).not.toContain(MESSAGE_ID);
		expect(statement?.statement).not.toContain(SECRET_CONTENT);
	});

	it("refuses to write a row that does not satisfy the domain's own guards, before any statement runs", async () => {
		const h = subject();
		await expect(h.repository.upsertMessages([messageWrite({ authorId: "not-a-snowflake" })])).rejects.toThrow(
			/message\.author_id/
		);
		expect(h.executor.statements).toEqual([]);
	});

	it("keeps the tombstone guard in the statement, so a replay cannot resurrect a deleted message's content", async () => {
		const h = subject();
		h.executor.reply(UPSERT_MARKER, []);
		await h.repository.upsertMessages([messageWrite()]);

		const statement = h.executor.matching(UPSERT_MARKER)[0]?.statement ?? "";
		expect(statement).toContain("ON CONFLICT (message_id) DO UPDATE");
		expect(statement).toContain("WHERE message.deleted_at IS NULL");
		expect(statement).toContain("EXCLUDED.edited_instant >= message.edited_instant");
		expect(statement).toContain("IS DISTINCT FROM");
		expect(statement).toContain("RETURNING message_id");
	});

	it("counts the rows the guards refused as written nothing, which is what R7 and R8 report", async () => {
		const h = subject();
		// The guard rejected both rows: a replay that changed nothing, and a stale backfill record.
		h.executor.reply(UPSERT_MARKER, []);
		const outcome = await h.repository.upsertMessages([
			messageWrite(),
			messageWrite({ messageId: "160000000000000402" })
		]);
		expect(outcome).toEqual({
			rowsWritten: 0,
			rowsSkipped: 2,
			attachmentsWritten: 0,
			attachmentsRemoved: 0,
			batches: 1
		});
	});

	it("replaces attachment metadata only for the messages whose row the guard actually wrote (R8, R11)", async () => {
		const h = subject();
		h.executor.reply(UPSERT_MARKER, [{ message_id: MESSAGE_ID }]);
		h.executor.reply(ATTACHMENT_SWEEP_MARKER, [{ attachment_id: "160000000000000500" }]);
		h.executor.reply(ATTACHMENT_INSERT_MARKER, [{ attachment_id: "160000000000000501" }]);

		const outcome = await h.repository.upsertMessages([
			messageWrite({ attachments: [attachment()] }),
			messageWrite({ messageId: "160000000000000402", attachments: [attachment("160000000000000502")] })
		]);

		expect(outcome.rowsWritten).toBe(1);
		expect(outcome).toMatchObject({ attachmentsRemoved: 1, attachmentsWritten: 1 });
		const sweep = h.executor.matching(ATTACHMENT_SWEEP_MARKER)[0];
		expect(sweep?.parameters?.[1]).toEqual([MESSAGE_ID]);
		const insert = h.executor.matching(ATTACHMENT_INSERT_MARKER)[0];
		expect(insert?.parameters?.[0]).toEqual([MESSAGE_ID]);
		// `size_bytes` is a `bigint` column, so it is bound as text, exactly as the ids are.
		expect(insert?.parameters?.[6]).toEqual(["1048576"]);
	});

	it("leaves a stored attachment set alone when the payload reported none, and sweeps it when it said none (R11)", async () => {
		const absent = subject();
		absent.executor.reply(UPSERT_MARKER, [{ message_id: MESSAGE_ID }]);
		const absentOutcome = await absent.repository.upsertMessages([messageWrite({ attachments: null })]);
		expect(absent.executor.matching(ATTACHMENT_SWEEP_MARKER)).toEqual([]);
		expect(absentOutcome.attachmentsRemoved).toBe(0);

		const explicit = subject();
		explicit.executor.reply(UPSERT_MARKER, [{ message_id: MESSAGE_ID }]);
		explicit.executor.reply(ATTACHMENT_SWEEP_MARKER, [{ attachment_id: "160000000000000501" }]);
		const explicitOutcome = await explicit.repository.upsertMessages([messageWrite({ attachments: [] })]);
		expect(explicit.executor.matching(ATTACHMENT_INSERT_MARKER)).toEqual([]);
		expect(explicitOutcome).toMatchObject({ attachmentsRemoved: 1, attachmentsWritten: 0 });
	});

	it("splits an import page of a hundred messages into bounded batches, one transaction each", async () => {
		const h = subject(new RecordingSqlExecutor(), { writeBatchSize: 40 });
		h.executor.reply(UPSERT_MARKER, []);
		const rows = Array.from({ length: 100 }, (_unused, index) =>
			messageWrite({ messageId: String(160000000000004000 + index) })
		);

		const outcome = await h.repository.upsertMessages(rows);

		expect(outcome.batches).toBe(3);
		expect(h.executor.transactions).toBe(3);
		expect(h.executor.matching(UPSERT_MARKER)).toHaveLength(3);
		expect(outcome.rowsSkipped).toBe(100);
		expect(h.executor.matching(UPSERT_MARKER)[0]?.parameters?.[0]).toHaveLength(40);
	});

	it("writes nothing at all for an empty import, rather than opening an empty transaction", async () => {
		const h = subject();
		const outcome = await h.repository.upsertMessages([]);
		expect(outcome).toEqual({
			rowsWritten: 0,
			rowsSkipped: 0,
			attachmentsWritten: 0,
			attachmentsRemoved: 0,
			batches: 0
		});
		expect(h.executor.statements).toEqual([]);
	});
});

describe("message store adapter — the guarded edit (R5)", () => {
	it("applies a guarded edit in one statement and reports what the row now carries", async () => {
		const h = subject();
		h.executor.reply(EDIT_MARKER, [{ edited_instant: EDITED_AT }]);

		const outcome = await h.repository.applyMessageEdit({
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			content: SECRET_CONTENT,
			editedInstant: EDITED_AT,
			messageType: null,
			attachments: null
		});

		expect(outcome.status).toBe("applied");
		expect(h.executor.transactions).toBe(0);
		expect(h.executor.matching(EDIT_MARKER)).toHaveLength(1);
		const statement = h.executor.matching(EDIT_MARKER)[0];
		expect(statement?.via).toBe("pool");
		expect(statement?.parameters).toEqual([GUILD_ID, MESSAGE_ID, SECRET_CONTENT, EDITED_AT, null]);
		expect(statement?.statement).toContain("m.edited_instant <= $4");
		expect(statement?.statement).toContain("m.deleted_at IS NULL");
		expect(statement?.statement).toContain("COALESCE($5::text, m.message_type)");
	});

	it("names a replayed edit as changed nothing, by reading the row the guard left alone", async () => {
		const h = subject();
		// The guarded UPDATE finds nothing to write; the point read shows the same state already stored.
		h.executor.reply(EDIT_MARKER, []);
		h.executor.reply(FIND_MARKER, [{ ...messageRow(), edited_instant: EDITED_AT, content: SECRET_CONTENT }]);

		const outcome = await h.repository.applyMessageEdit({
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			content: SECRET_CONTENT,
			editedInstant: EDITED_AT,
			messageType: null,
			attachments: null
		});

		expect(outcome.status).toBe("unchanged");
		expect(outcome.storedEditedInstant).toEqual(EDITED_AT);
	});

	it("names a late older edit as stale, the same answer the SQL guard gave", async () => {
		const h = subject();
		h.executor.reply(EDIT_MARKER, []);
		h.executor.reply(FIND_MARKER, [{ ...messageRow(), edited_instant: LATER_EDIT_AT }]);

		const outcome = await h.repository.applyMessageEdit({
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			content: "the pre-edit text",
			editedInstant: EDITED_AT,
			messageType: null,
			attachments: null
		});

		expect(outcome.status).toBe("stale");
		expect(outcome.storedEditedInstant).toEqual(LATER_EDIT_AT);
	});

	it("names a tombstoned row and a missing row differently, because the caller reports them differently", async () => {
		const tombstoned = subject();
		tombstoned.executor.reply(EDIT_MARKER, []);
		tombstoned.executor.reply(FIND_MARKER, [{ ...messageRow(), content: null, deleted_at: DELETED_AT }]);
		await expect(
			tombstoned.repository.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "text",
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: null
			})
		).resolves.toMatchObject({ status: "tombstoned" });

		const missing = subject();
		missing.executor.reply(EDIT_MARKER, []);
		missing.executor.reply(FIND_MARKER, []);
		await expect(
			missing.repository.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "text",
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: null
			})
		).resolves.toMatchObject({ status: "absent" });
	});

	it("replaces content and attachment set in one transaction when a reconciled edit reported both (R11)", async () => {
		const h = subject();
		h.executor.reply(EDIT_MARKER, [{ edited_instant: EDITED_AT }]);
		h.executor.reply(ATTACHMENT_SWEEP_MARKER, [{ attachment_id: "160000000000000500" }]);
		h.executor.reply(ATTACHMENT_INSERT_MARKER, [{ attachment_id: "160000000000000501" }]);

		const outcome = await h.repository.applyMessageEdit({
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			content: SECRET_CONTENT,
			editedInstant: EDITED_AT,
			messageType: "reply",
			attachments: [attachment()]
		});

		expect(outcome).toMatchObject({ status: "applied", attachmentsRemoved: 1, attachmentsWritten: 1 });
		expect(h.executor.transactions).toBe(1);
		expect(h.executor.matching(EDIT_MARKER)[0]?.via).toBe("session");
		expect(h.executor.matching(ATTACHMENT_INSERT_MARKER)[0]?.via).toBe("session");
	});

	it("does not touch attachment rows for an edit that reported no set", async () => {
		const h = subject();
		h.executor.reply(EDIT_MARKER, [{ edited_instant: EDITED_AT }]);
		await h.repository.applyMessageEdit({
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			content: "text",
			editedInstant: EDITED_AT,
			messageType: null,
			attachments: null
		});
		expect(h.executor.matching(ATTACHMENT_SWEEP_MARKER)).toEqual([]);
	});

	it("refuses an edit whose content is not text before any statement runs", async () => {
		const h = subject();
		await expect(
			h.repository.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: null as unknown as string,
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: null
			})
		).rejects.toThrow(/message\.content/);
		expect(h.executor.statements).toEqual([]);
	});
});

describe("message store adapter — the tombstone (R6, ADR-0007)", () => {
	it("marks only the live rows the deletion named, and reports the rest as counted facts", async () => {
		const h = subject();
		h.executor.reply("SELECT message_id, deleted_at", [
			{ message_id: MESSAGE_ID, deleted_at: null },
			{ message_id: "160000000000000402", deleted_at: DELETED_AT }
		]);
		h.executor.reply(ATTACHMENT_SWEEP_MARKER, [
			{ attachment_id: "160000000000000501" },
			{ attachment_id: "160000000000000502" }
		]);
		h.executor.reply(TOMBSTONE_MARKER, [{ message_id: MESSAGE_ID }]);

		const outcome = await h.repository.tombstoneMessages(
			tombstoneWrite([MESSAGE_ID, "160000000000000402", "160000000000000403"])
		);

		expect(outcome).toEqual({
			messagesTombstoned: 1,
			attachmentsRemoved: 2,
			alreadyTombstoned: 1,
			unknownMessageIds: ["160000000000000403"],
			batches: 1
		});
		expect(h.executor.transactions).toBe(1);
		// The statement never deletes a row: content goes, the row stays for idempotency.
		expect(h.executor.matching("DELETE FROM message ")).toEqual([]);
		expect(h.executor.matching(TOMBSTONE_MARKER)[0]?.parameters).toEqual([GUILD_ID, [MESSAGE_ID], DELETED_AT]);
		expect(h.executor.matching(TOMBSTONE_MARKER)[0]?.statement).toContain("AND deleted_at IS NULL");
	});

	it("sweeps attachment metadata before marking the row, in the same transaction", async () => {
		const h = subject();
		h.executor.reply("SELECT message_id, deleted_at", [{ message_id: MESSAGE_ID, deleted_at: null }]);
		h.executor.reply(ATTACHMENT_SWEEP_MARKER, []);
		h.executor.reply(TOMBSTONE_MARKER, [{ message_id: MESSAGE_ID }]);

		await h.repository.tombstoneMessages(tombstoneWrite());

		const order = h.executor.statements.map((line) => line.statement).join("\n");
		expect(order.indexOf(ATTACHMENT_SWEEP_MARKER)).toBeLessThan(order.indexOf(TOMBSTONE_MARKER));
		expect(h.executor.statements.filter((line) => line.via === "BEGIN")).toHaveLength(1);
	});

	it("issues no write statement when every named id is already tombstoned", async () => {
		const h = subject();
		h.executor.reply("SELECT message_id, deleted_at", [{ message_id: MESSAGE_ID, deleted_at: DELETED_AT }]);

		const outcome = await h.repository.tombstoneMessages(tombstoneWrite());

		expect(outcome.messagesTombstoned).toBe(0);
		expect(outcome.alreadyTombstoned).toBe(1);
		expect(h.executor.matching(TOMBSTONE_MARKER)).toEqual([]);
		expect(h.executor.matching(ATTACHMENT_SWEEP_MARKER)).toEqual([]);
	});

	it("batches a large deletion list into bounded transactions", async () => {
		const h = subject(new RecordingSqlExecutor(), { writeBatchSize: 2 });
		const ids = ["1", "2", "3", "4", "5"].map((tail) => `16000000000000040${tail}`);
		h.executor.reply("SELECT message_id, deleted_at", []);
		const outcome = await h.repository.tombstoneMessages(tombstoneWrite(ids));

		expect(outcome.batches).toBe(3);
		expect(h.executor.transactions).toBe(3);
		expect(outcome.unknownMessageIds).toHaveLength(5);
	});

	it("refuses a deletion that names no id instead of letting a statement sweep on an empty list", async () => {
		const h = subject();
		await expect(h.repository.tombstoneMessages(tombstoneWrite([]))).rejects.toThrow(/message\.message_ids/);
		expect(h.executor.statements).toEqual([]);
	});
});

describe("message store adapter — the bulk exclusion (R6)", () => {
	it("sweeps bounded pages of one channel's messages until a page comes back empty", async () => {
		const h = subject(new RecordingSqlExecutor(), { exclusionPageSize: 2 });
		h.executor.reply(
			"FROM message\n\tWHERE guild_id = $1 AND channel_id",
			[{ message_id: MESSAGE_ID }, { message_id: "160000000000000402" }],
			[]
		);
		h.executor.reply(ATTACHMENT_SWEEP_MARKER, [{ attachment_id: "160000000000000501" }]);
		h.executor.reply(TOMBSTONE_MARKER, [{ message_id: MESSAGE_ID }, { message_id: "160000000000000402" }]);

		const outcome = await h.repository.excludeChannelMessages({
			guildId: GUILD_ID,
			channelIds: [CHANNEL_ID],
			deletedAt: DELETED_AT
		});

		expect(outcome.messagesTombstoned).toBe(2);
		expect(outcome.attachmentsRemoved).toBe(1);
		expect(outcome.batches).toBe(1);
		const page = h.executor.matching("FROM message\n\tWHERE guild_id = $1 AND channel_id")[0];
		expect(page?.parameters).toEqual([GUILD_ID, [CHANNEL_ID], 2]);
		expect(page?.statement).toContain("AND deleted_at IS NULL");
		expect(page?.statement).toContain("LIMIT $3");
	});

	it("names a sweep that covers a channel and its threads as the id set it was handed", async () => {
		const h = subject();
		h.executor.reply("FROM message\n\tWHERE guild_id = $1 AND channel_id", []);
		await h.repository.excludeChannelMessages({
			guildId: GUILD_ID,
			channelIds: [CHANNEL_ID, "160000000000000202"],
			deletedAt: DELETED_AT
		});
		expect(h.executor.matching("AND channel_id = ANY($2::bigint[])")).toHaveLength(1);
	});

	it("refuses an exclusion that names no channel rather than sweeping the Guild", async () => {
		const h = subject();
		await expect(
			h.repository.excludeChannelMessages({ guildId: GUILD_ID, channelIds: [], deletedAt: DELETED_AT })
		).rejects.toThrow(/message\.channel_ids/);
		expect(h.executor.statements).toEqual([]);
	});
});

describe("message store adapter — the point read a tombstone can never serve (R6)", () => {
	it("reads one row back as application types, with no driver shape and no SQL leaking out", async () => {
		const h = subject();
		h.executor.reply(FIND_MARKER, [messageRow()]);
		h.executor.reply("FROM message_attachment", [attachmentRow()]);

		const stored = await h.repository.findMessage(GUILD_ID, MESSAGE_ID);

		expect(stored).toEqual(
			storedMessage({
				attachments: [attachment()],
				content: SECRET_CONTENT,
				editedInstant: null
			})
		);
		expect(stored?.createdInstant).toBeInstanceOf(Date);
		expect(typeof stored?.messageId).toBe("string");
		// `size_bytes` is `int8`, which the driver hands back as text; the record carries a number.
		expect(stored?.attachments[0]?.sizeBytes).toBe(1_048_576);
	});

	it("returns no content and no attachment metadata for a tombstoned row, and issues no attachment read", async () => {
		const h = subject();
		h.executor.reply(FIND_MARKER, [{ ...messageRow(), content: null, deleted_at: DELETED_AT }]);

		const stored = await h.repository.findMessage(GUILD_ID, MESSAGE_ID);

		expect(stored?.deletedAt).toEqual(DELETED_AT);
		expect(stored?.content).toBeNull();
		expect(stored?.attachments).toEqual([]);
		expect(h.executor.matching("FROM message_attachment")).toEqual([]);
		expect(stored?.messageId).toBe(MESSAGE_ID);
		expect(stored?.authorId).toBeDefined();
	});

	it("answers null for a message the store never had, rather than inventing a row", async () => {
		const h = subject();
		h.executor.reply(FIND_MARKER, []);
		expect(await h.repository.findMessage(GUILD_ID, MESSAGE_ID)).toBeNull();
	});

	it("validates the Guild id of the read too, so no statement can run unscoped", async () => {
		const h = subject();
		await expect(h.repository.findMessage("0", MESSAGE_ID)).rejects.toThrow(/message\.guild_id/);
		expect(h.executor.statements).toEqual([]);
	});

	it("refuses an attachment size the driver could not represent instead of rounding it", async () => {
		const h = subject();
		h.executor.reply(FIND_MARKER, [messageRow()]);
		h.executor.reply("FROM message_attachment", [attachmentRow({ size_bytes: "9007199254740993" })]);
		await expect(h.repository.findMessage(GUILD_ID, MESSAGE_ID)).rejects.toThrow(/out-of-safe-integer-range/);
	});

	it("reads the reply reference back as the ids it was, keeping the channel it was posted in", async () => {
		const h = subject();
		h.executor.reply(FIND_MARKER, [
			{
				...messageRow(),
				reply_message_id: "160000000000000402",
				reply_channel_id: CHANNEL_ID,
				reply_guild_id: GUILD_ID
			}
		]);
		h.executor.reply("FROM message_attachment", []);

		const stored = await h.repository.findMessage(GUILD_ID, MESSAGE_ID);
		expect(stored?.replyReference).toEqual({
			messageId: "160000000000000402",
			channelId: CHANNEL_ID,
			guildId: GUILD_ID
		});
	});
});

describe("message store adapter — nothing leaks", () => {
	it("names no message text, no URL and no file name in any statement it builds", async () => {
		const h = subject();
		h.executor.reply(UPSERT_MARKER, [{ message_id: MESSAGE_ID }]);
		h.executor.reply(ATTACHMENT_SWEEP_MARKER, []);
		h.executor.reply(ATTACHMENT_INSERT_MARKER, [{ attachment_id: "160000000000000501" }]);

		await h.repository.upsertMessages([messageWrite({ attachments: [attachment()] })]);

		const all = h.executor.statements.map((line) => line.statement).join("\n");
		expect(all).not.toContain(SECRET_CONTENT);
		expect(all).not.toContain(SECRET_URL);
		expect(all).not.toContain(GUILD_ID);
	});

	it("surfaces a database failure as it is, with no translation of an unexpected constraint", async () => {
		const h = subject();
		const failure = Object.assign(new Error("deadlock detected"), { code: "40P01" });
		h.executor.failOn(UPSERT_MARKER, () => failure);

		await expect(h.repository.upsertMessages([messageWrite()])).rejects.toBe(failure);
	});
});
