import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { PostgresMessageStoreRepository } from "../../src/features/ingestion/repositories/postgres-message-store.repository.js";
import {
	CHANNEL_ID,
	CREATED_AT,
	DELETED_AT,
	EDITED_AT,
	GUILD_ID,
	LATER_EDIT_AT,
	MESSAGE_ID,
	OTHER_CHANNEL_ID,
	SECRET_CONTENT,
	SECRET_FILENAME,
	SECRET_URL,
	SECRET_USERNAME,
	THREAD_ID,
	attachment,
	messageWrite,
	tombstoneWrite
} from "../features/ingestion/fakes/message-fixtures.js";

/**
 * T1 evidence — the ingestion message store against a real PostgreSQL.
 *
 * The doubles in `tests/features/ingestion/` prove what the adapter asks for; this file proves what the
 * schema and the statements actually do, because the claims that matter here are only meaningful on a server:
 *
 * - **R7, idempotency.** A second delivery of one message changes no row and adds none — proven by reading the
 *   table back, not by trusting an `ON CONFLICT` clause.
 * - **R5 and R8, never a regression.** The guard lives in the write statement, so it holds when two deliveries
 *   race, which a unit test cannot exercise. The three shapes of it are all here: an older edit instant, an
 *   edit-less backfill record against a row that has one, and a create that arrives after a tombstone.
 * - **R6 with ADR-0007, the tombstone.** Content and attachment metadata go, physically; the id, author, both
 *   instants and `deleted_at` stay; a replayed deletion does not move the instant.
 * - **R11, metadata only.** The attachment table's own column list is the proof — read back from
 *   `information_schema`, it has no column that could hold bytes or a storage reference.
 * - **R1, no cross-feature reach.** `message` has no foreign key at all, which is the structural form of
 *   "ingestion never references another feature's internal table", and the composite guild-scoped key is what
 *   an attachment row cannot escape.
 * - **Bounded batches, one transaction each.** A failure inside a batch leaves nothing half-written, including
 *   the attachment rows of the messages that statement would have written.
 *
 * Without `TEST_DATABASE_URL` this suite is skipped and the harness prints the UNAVAILABLE banner; skipped is
 * missing evidence, never a pass.
 */

const GUILD_ONE_MESSAGE = "160000000000000401";
const GUILD_TWO_MESSAGE = "160000000000000402";
const THREAD_MESSAGE = "160000000000000403";
const OTHER_CHANNEL_MESSAGE = "160000000000000404";
const LARGEST_SNOWFLAKE = "9223372036854775807";
const AUTHOR_ID = "160000000000000101";
const OTHER_GUILD_ID = "160000000000000999";
const ATTACHMENT_ONE = "160000000000000501";
const ATTACHMENT_TWO = "160000000000000502";

/**
 * The one statement this file writes by hand instead of through the repository: the columns are named once,
 * as literal text, and every value arrives bound — so the schema-level refusals can be shown without the
 * domain guards standing in the way, and without any interpolated value in the statement.
 */
const RAW_MESSAGE_INSERT = `
	INSERT INTO message (message_id, guild_id, channel_id, author_id, message_type, content, created_instant, reply_channel_id)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

const RAW_ATTACHMENT_INSERT = `
	INSERT INTO message_attachment (message_id, attachment_id, guild_id, filename, url, size_bytes)
	VALUES ($1, $2, $3, $4, $5, $6)
`;

/** The same insert with the content type named, so every R11 column has a refusal path. */
const RAW_ATTACHMENT_FULL_INSERT = `
	INSERT INTO message_attachment (message_id, attachment_id, guild_id, filename, url, content_type, size_bytes)
	VALUES ($1, $2, $3, $4, $5, $6, $7)
`;

interface Subject {
	readonly database: IsolatedTestDatabase;
	readonly pool: Pool;
	readonly store: PostgresMessageStoreRepository;
}

describe.skipIf(!HAS_TEST_DATABASE)("ingestion message store (real PostgreSQL)", () => {
	let subject: Subject;

	beforeAll(async () => {
		subject = await openSubject("ingestion_messages");
	}, 180_000);

	afterAll(async () => {
		// Best effort: a failed case must not leak a database into the shared server.
		await subject?.database.close();
	});

	beforeEach(async () => {
		await subject.database.resetMessageStore();
	});

	async function openSubject(
		label: string,
		bounds: { writeBatchSize?: number; exclusionPageSize?: number } = {}
	): Promise<Subject> {
		const database = await openIsolatedTestDatabase(label);
		return {
			database,
			pool: database.pool,
			store: new PostgresMessageStoreRepository({
				executor: database.executor,
				writeBatchSize: bounds.writeBatchSize ?? 200,
				exclusionPageSize: bounds.exclusionPageSize ?? 200
			})
		};
	}

	/** One count read back from the real table: the evidence a sweep or a replay claim is checked against. */
	async function rowCount(pool: Pool, statement: string, parameters: readonly unknown[] = []): Promise<number> {
		const { rows } = await pool.query<{ total: string }>(statement, [...parameters]);
		return Number(rows[0]?.total ?? "0");
	}

	describe("the schema's own integrity rules", () => {
		it("creates exactly the two tables the message store owns, with the columns the rules name", async () => {
			const { rows } = await subject.pool.query<{ table_name: string; column_name: string }>(
				`
				SELECT table_name, column_name
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name IN ('message', 'message_attachment')
				ORDER BY table_name, ordinal_position
			`
			);
			const columnsOf = (table: string): string[] =>
				rows.filter((row) => row.table_name === table).map((row) => row.column_name);

			expect(columnsOf("message")).toEqual([
				"message_id",
				"guild_id",
				"channel_id",
				"author_id",
				"author_username",
				"author_is_bot",
				"webhook_id",
				"message_type",
				"content",
				"created_instant",
				"edited_instant",
				"reply_message_id",
				"reply_channel_id",
				"reply_guild_id",
				"deleted_at"
			]);
			// R11's proof: attachment metadata and nothing else. No column here can hold bytes, a storage
			// reference or a local path, so "never downloaded, stored or indexed" is a fact about the schema.
			expect(columnsOf("message_attachment")).toEqual([
				"message_id",
				"attachment_id",
				"guild_id",
				"filename",
				"url",
				"content_type",
				"size_bytes"
			]);
		});

		it("holds no foreign key out of the message table, so ingestion reaches no other feature's rows (R1)", async () => {
			const { rows } = await subject.pool.query<{
				conname: string;
				from_table: string;
				to_table: string;
				confdeltype: string;
			}>(
				`
					SELECT con.conname, src.relname AS from_table, tgt.relname AS to_table, con.confdeltype
					FROM pg_constraint AS con
					JOIN pg_class AS src ON src.oid = con.conrelid
					JOIN pg_class AS tgt ON tgt.oid = con.confrelid
					WHERE con.contype = 'f'
						AND src.relname IN ('message', 'message_attachment')
						AND src.relnamespace = current_schema()::regnamespace
				`
			);

			// The only reference is the attachment set back to its own message, composite on the guild id.
			expect(rows.map((row) => `${row.from_table}->${row.to_table}`).sort()).toEqual([
				"message_attachment->message"
			]);
			// `message` itself points at nothing: not the registry's guild row, not a channel row. A message
			// mirror must survive a registry row being deleted, and it must never depend on another feature's
			// table existing (docs/architecture/structure.md; guild-state Contracts).
			expect(rows.filter((row) => row.from_table === "message")).toEqual([]);
			// NO ACTION everywhere: a cascade the repository forgot is a constraint violation, not an orphan.
			expect(new Set(rows.map((row) => row.confdeltype))).toEqual(new Set(["a"]));
		});

		it("keeps every removal explicit, with no cascade rule on any message-store constraint", async () => {
			const { rows } = await subject.pool.query<{ confdeltype: string }>(
				`
					SELECT con.confdeltype
					FROM pg_constraint AS con
					JOIN pg_class AS src ON src.oid = con.conrelid
					WHERE con.contype = 'f' AND src.relname IN ('message', 'message_attachment')
				`
			);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((row) => row.confdeltype === "a")).toBe(true);
		});

		it("serves no tombstoned content to a read, because the row holds none to serve", async () => {
			await subject.store.upsertMessages([messageWrite({ messageId: MESSAGE_ID })]);
			await subject.store.tombstoneMessages(tombstoneWrite([MESSAGE_ID]));

			const { rows } = await subject.pool.query<{ content: string | null; deleted_at: Date | null }>(
				"SELECT content, deleted_at FROM message WHERE message_id = $1",
				[BigInt(MESSAGE_ID)]
			);
			expect(rows[0]?.content).toBeNull();
			expect(rows[0]?.deleted_at).toBeInstanceOf(Date);
		});
	});

	describe("the schema's own refusals, with the repository bypassed", () => {
		it("refuses a tombstone that kept its content and a live row that has none (R6, ADR-0007)", async () => {
			await subject.store.upsertMessages([messageWrite({ messageId: MESSAGE_ID })]);

			// Marking a row deleted while its text stays is the state the mirror must never be able to hold.
			await expect(
				subject.pool.query("UPDATE message SET deleted_at = $1 WHERE message_id = $2", [
					DELETED_AT,
					BigInt(MESSAGE_ID)
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_content_is_dropped_by_a_tombstone" });

			// The other half of the same check: a live row cannot be emptied of content either.
			await expect(
				subject.pool.query("UPDATE message SET content = NULL WHERE message_id = $1", [BigInt(MESSAGE_ID)])
			).rejects.toMatchObject({ code: "23514", constraint: "message_content_is_dropped_by_a_tombstone" });

			// The row the repository tombstones satisfies the same rule, so the rule is about the store rather
			// than about the one statement that writes it.
			await subject.store.tombstoneMessages(tombstoneWrite([MESSAGE_ID]));
			expect(
				await rowCount(
					subject.pool,
					"SELECT COUNT(*) AS total FROM message WHERE deleted_at IS NOT NULL AND content IS NULL"
				)
			).toBe(1);
		});

		it("refuses a zero or negative snowflake in any id column, not merely a malformed string", async () => {
			// The domain guard refuses these before a statement is built; the column check is the rule that still
			// holds for a statement written by hand. Each id column is tried, so the check is proven per column.
			await expect(
				subject.pool.query(RAW_MESSAGE_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt("0"),
					BigInt(CHANNEL_ID),
					BigInt(AUTHOR_ID),
					"default",
					"text",
					CREATED_AT,
					null
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_ids_are_positive" });

			await expect(
				subject.pool.query(RAW_MESSAGE_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(GUILD_ID),
					BigInt("-1"),
					BigInt(AUTHOR_ID),
					"default",
					"text",
					CREATED_AT,
					null
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_ids_are_positive" });

			await expect(
				subject.pool.query(RAW_MESSAGE_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(GUILD_ID),
					BigInt(CHANNEL_ID),
					BigInt("0"),
					"default",
					"text",
					CREATED_AT,
					null
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_ids_are_positive" });

			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(0);
		});

		it("refuses a reply reference that names no message, the half the domain also drops (R4)", async () => {
			// `RAW_MESSAGE_INSERT` carries a reply channel and no replied message id: exactly the half reference
			// the check forbids.
			await expect(
				subject.pool.query(RAW_MESSAGE_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(GUILD_ID),
					BigInt(CHANNEL_ID),
					BigInt(AUTHOR_ID),
					"default",
					"text",
					CREATED_AT,
					BigInt(THREAD_ID)
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_reply_reference_has_a_target" });

			// The same row with no reply channel at all lands, which is what makes the refusal above
			// attributable to the reference rather than to the row.
			await subject.pool.query(RAW_MESSAGE_INSERT, [
				BigInt(MESSAGE_ID),
				BigInt(GUILD_ID),
				BigInt(CHANNEL_ID),
				BigInt(AUTHOR_ID),
				"default",
				"text",
				CREATED_AT,
				null
			]);
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
		});

		it("refuses a blank message type, which is the one field R4 says every row must carry", async () => {
			await expect(
				subject.pool.query(RAW_MESSAGE_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(GUILD_ID),
					BigInt(CHANNEL_ID),
					BigInt(AUTHOR_ID),
					"",
					"text",
					CREATED_AT,
					null
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_type_is_named" });
		});

		it("refuses attachment metadata that is not metadata, per column (R11)", async () => {
			await subject.store.upsertMessages([messageWrite({ messageId: MESSAGE_ID })]);

			// One bound value swapped per column, every other column left at a value the table accepts, so each
			// refusal names the constraint it belongs to.
			await expect(
				subject.pool.query(RAW_ATTACHMENT_FULL_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(ATTACHMENT_ONE),
					BigInt(GUILD_ID),
					"",
					"https://cdn.example/x.pdf",
					"application/pdf",
					1
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_attachment_filename_is_named" });

			await expect(
				subject.pool.query(RAW_ATTACHMENT_FULL_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(ATTACHMENT_TWO),
					BigInt(GUILD_ID),
					"x.pdf",
					"",
					"application/pdf",
					1
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_attachment_url_is_named" });

			await expect(
				subject.pool.query(RAW_ATTACHMENT_FULL_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(ATTACHMENT_ONE),
					BigInt(GUILD_ID),
					"x.pdf",
					"https://cdn.example/x.pdf",
					"  ",
					1
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_attachment_content_type_is_never_blank" });

			await expect(
				subject.pool.query(RAW_ATTACHMENT_FULL_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(ATTACHMENT_ONE),
					BigInt(GUILD_ID),
					"x.pdf",
					"https://cdn.example/x.pdf",
					"application/pdf",
					-1
				])
			).rejects.toMatchObject({ code: "23514", constraint: "message_attachment_size_is_never_negative" });

			// Every column of R11's list is present and accepted together, and none of them is a byte array.
			await subject.pool.query(RAW_ATTACHMENT_FULL_INSERT, [
				BigInt(MESSAGE_ID),
				BigInt(ATTACHMENT_ONE),
				BigInt(GUILD_ID),
				"x.pdf",
				"https://cdn.example/x.pdf",
				"application/pdf",
				1
			]);
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(1);
		});

		it("refuses a second row for one message id: R7's natural key is the primary key itself", async () => {
			await subject.store.upsertMessages([messageWrite({ messageId: MESSAGE_ID })]);
			await expect(
				subject.pool.query(RAW_MESSAGE_INSERT, [
					BigInt(MESSAGE_ID),
					BigInt(GUILD_ID),
					BigInt(OTHER_CHANNEL_ID),
					BigInt(AUTHOR_ID),
					"default",
					"text",
					CREATED_AT,
					null
				])
			).rejects.toMatchObject({ code: "23505", constraint: "message_pkey" });
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
		});

		it("keeps every removal explicit: a message cannot be deleted out from under its attachment rows", async () => {
			await subject.store.upsertMessages([
				messageWrite({ messageId: MESSAGE_ID, attachments: [attachment(ATTACHMENT_ONE)] })
			]);

			// `NO ACTION` rather than a cascade: a sweep the repository forgot becomes this refusal instead of a
			// silently orphaned attachment row (ADR-0007 keeps the message row, and no statement removes it).
			await expect(
				subject.pool.query("DELETE FROM message WHERE message_id = $1", [BigInt(MESSAGE_ID)])
			).rejects.toMatchObject({ code: "23503", constraint: "message_attachment_guild_id_message_id_fkey" });
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(1);
		});
	});

	describe("R4 — what a stored message keeps, and what comes back out", () => {
		it("writes and reads back every fact a create event carried, with attachment metadata and a reply reference", async () => {
			const written = await subject.store.upsertMessages([
				messageWrite({
					messageId: MESSAGE_ID,
					authorUsername: SECRET_USERNAME,
					authorIsBot: false,
					webhookId: "160000000000000301",
					content: SECRET_CONTENT,
					createdInstant: CREATED_AT,
					editedInstant: EDITED_AT,
					messageType: "reply",
					replyReference: {
						messageId: "160000000000000409",
						channelId: THREAD_ID,
						guildId: GUILD_ID
					},
					attachments: [attachment(ATTACHMENT_ONE), attachment(ATTACHMENT_TWO)]
				})
			]);

			expect(written).toMatchObject({ rowsWritten: 1, rowsSkipped: 0, batches: 1, attachmentsWritten: 2 });

			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored).not.toBeNull();
			expect(stored?.channelId).toBe(CHANNEL_ID);
			expect(stored?.authorUsername).toBe(SECRET_USERNAME);
			expect(stored?.authorIsBot).toBe(false);
			expect(stored?.webhookId).toBe("160000000000000301");
			expect(stored?.content).toBe(SECRET_CONTENT);
			expect(stored?.messageType).toBe("reply");
			expect(stored?.createdInstant).toEqual(CREATED_AT);
			expect(stored?.editedInstant).toEqual(EDITED_AT);
			expect(stored?.deletedAt).toBeNull();
			expect(stored?.replyReference).toEqual({
				messageId: "160000000000000409",
				channelId: THREAD_ID,
				guildId: GUILD_ID
			});
			expect(stored?.attachments.map((row) => row.attachmentId)).toEqual([ATTACHMENT_ONE, ATTACHMENT_TWO]);
			expect(stored?.attachments[0]).toEqual({
				attachmentId: ATTACHMENT_ONE,
				filename: SECRET_FILENAME,
				url: SECRET_URL,
				contentType: "application/pdf",
				sizeBytes: 1_048_576
			});
		});

		it("carries the largest snowflake through a `bigint` column unchanged, as text in and text out (R9 there)", async () => {
			await subject.store.upsertMessages([
				messageWrite({
					messageId: LARGEST_SNOWFLAKE,
					guildId: GUILD_ID,
					channelId: CHANNEL_ID,
					authorId: LARGEST_SNOWFLAKE
				})
			]);

			const stored = await subject.store.findMessage(GUILD_ID, LARGEST_SNOWFLAKE);
			expect(stored?.messageId).toBe(LARGEST_SNOWFLAKE);
			expect(stored?.authorId).toBe(LARGEST_SNOWFLAKE);
			// No JavaScript number anywhere in the record the feature hands a caller.
			expect(typeof stored?.messageId).toBe("string");
			expect(stored?.attachments).toEqual([]);
		});

		it("keeps a message posted in a thread under the thread's own id, which is what the exclusion matches (R2 there)", async () => {
			await subject.store.upsertMessages([messageWrite({ messageId: THREAD_MESSAGE, channelId: THREAD_ID })]);

			const stored = await subject.store.findMessage(GUILD_ID, THREAD_MESSAGE);
			expect(stored?.channelId).toBe(THREAD_ID);
			expect(
				await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message WHERE channel_id = $1", [
					BigInt(CHANNEL_ID)
				])
			).toBe(0);
		});

		it("answers no row for a message the store never had, rather than inventing one", async () => {
			expect(await subject.store.findMessage(GUILD_ID, MESSAGE_ID)).toBeNull();
		});

		it("scopes every read to the guild it was given, so a foreign id cannot be served (R1)", async () => {
			await subject.store.upsertMessages([messageWrite({ messageId: MESSAGE_ID, guildId: GUILD_ID })]);
			expect(await subject.store.findMessage(OTHER_GUILD_ID, MESSAGE_ID)).toBeNull();
		});
	});

	describe("R7 — replaying a delivery changes nothing observable", () => {
		it("writes a message once and then changes nothing when the same event is delivered again", async () => {
			const event = messageWrite({
				messageId: MESSAGE_ID,
				attachments: [attachment(ATTACHMENT_ONE)]
			});

			const first = await subject.store.upsertMessages([event]);
			const second = await subject.store.upsertMessages([event]);

			expect(first.rowsWritten).toBe(1);
			// The whole-row guard refuses the replay, and the attachment set is only replaced for a message the
			// guard actually wrote: a refused row must not widen or narrow the newer set (R8). Zero counts here are
			// therefore the proof that the second delivery moved nothing, not a gap in the evidence.
			expect(second).toMatchObject({
				rowsWritten: 0,
				rowsSkipped: 1,
				attachmentsWritten: 0,
				attachmentsRemoved: 0
			});

			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(1);

			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.content).toBe(SECRET_CONTENT);
			expect(stored?.attachments.map((row) => row.attachmentId)).toEqual([ATTACHMENT_ONE]);
		});

		it("replacing the same attachment ids again leaves one row per attachment, not two", async () => {
			const event = messageWrite({
				messageId: MESSAGE_ID,
				attachments: [
					{ ...attachment(ATTACHMENT_ONE), sizeBytes: 10 },
					{ ...attachment(ATTACHMENT_TWO), sizeBytes: 20 }
				]
			});
			await subject.store.upsertMessages([event]);
			await subject.store.upsertMessages([event]);

			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(2);
			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.attachments.map((row) => row.sizeBytes)).toEqual([10, 20]);
		});
	});

	describe("R5, R8 — an edit never overwrites newer state, whatever order it arrives in", () => {
		beforeEach(async () => {
			await subject.store.upsertMessages([messageWrite({ messageId: MESSAGE_ID, content: "the first text" })]);
		});

		it("applies an edit that carries a newer instant and reports what the row now holds", async () => {
			const applied = await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "the edited text",
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: null
			});

			expect(applied).toMatchObject({ status: "applied", storedEditedInstant: EDITED_AT });
			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.content).toBe("the edited text");
			expect(stored?.editedInstant).toEqual(EDITED_AT);
		});

		it("refuses the same edit when an older instant arrives afterwards, leaving the content alone", async () => {
			await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "the newer text",
				editedInstant: LATER_EDIT_AT,
				messageType: null,
				attachments: null
			});

			const refused = await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "the older text",
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: null
			});

			expect(refused.status).toBe("stale");
			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.content).toBe("the newer text");
			expect(stored?.editedInstant).toEqual(LATER_EDIT_AT);
		});

		it("refuses a REST backfill record of the pre-edit version that has no edit instant at all (R8's case)", async () => {
			await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "the edited text",
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: null
			});

			const outcome = await subject.store.upsertMessages([
				messageWrite({ messageId: MESSAGE_ID, content: "the pre-edit text", editedInstant: null })
			]);
			expect(outcome).toMatchObject({ rowsWritten: 0, rowsSkipped: 1 });

			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.content).toBe("the edited text");
		});

		it("lets the backfill record through when it is the newest state the gateway has not applied yet", async () => {
			const outcome = await subject.store.upsertMessages([
				messageWrite({ messageId: MESSAGE_ID, content: "backfilled text", editedInstant: EDITED_AT })
			]);

			expect(outcome.rowsWritten).toBe(1);
			expect((await subject.store.findMessage(GUILD_ID, MESSAGE_ID))?.content).toBe("backfilled text");
		});

		it("names a replay of an identical edit as changed nothing, not as applied", async () => {
			const edit = {
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "the same text",
				editedInstant: EDITED_AT,
				messageType: "default" as const,
				attachments: null
			};

			expect((await subject.store.applyMessageEdit(edit)).status).toBe("applied");
			expect((await subject.store.applyMessageEdit(edit)).status).toBe("unchanged");
		});

		it("replaces an edit's attachment metadata whole, so a removed file cannot survive as a stale row (R11)", async () => {
			await subject.store.upsertMessages([
				messageWrite({
					messageId: MESSAGE_ID,
					attachments: [attachment(ATTACHMENT_ONE), attachment(ATTACHMENT_TWO)]
				})
			]);

			const replaced = await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "text",
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: [{ ...attachment(ATTACHMENT_TWO), filename: "renamed.pdf" }]
			});

			expect(replaced).toMatchObject({ status: "applied", attachmentsRemoved: 2, attachmentsWritten: 1 });
			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.attachments.map((row) => `${row.attachmentId}:${row.filename}`)).toEqual([
				`${ATTACHMENT_TWO}:renamed.pdf`
			]);
		});

		it("sweeps the attachment set an edit reports as empty, and leaves it when the edit reported none", async () => {
			await subject.store.upsertMessages([
				messageWrite({ messageId: MESSAGE_ID, attachments: [attachment(ATTACHMENT_ONE)] })
			]);

			await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "text",
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: null
			});
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(1);

			const cleared = await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "more text",
				editedInstant: LATER_EDIT_AT,
				messageType: null,
				attachments: []
			});
			expect(cleared).toMatchObject({ attachmentsRemoved: 1, attachmentsWritten: 0 });
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(0);
		});

		it("refuses to edit a message the store never had, rather than inventing a row from half a payload", async () => {
			const outcome = await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: "160000000000000999",
				content: "text",
				editedInstant: EDITED_AT,
				messageType: null,
				attachments: null
			});
			expect(outcome.status).toBe("absent");
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
		});
	});

	describe("R6, ADR-0007 — deletion tombstones the message and drops its content", () => {
		beforeEach(async () => {
			await subject.store.upsertMessages([
				messageWrite({
					messageId: MESSAGE_ID,
					editedInstant: EDITED_AT,
					attachments: [attachment(ATTACHMENT_ONE)]
				}),
				messageWrite({ messageId: GUILD_TWO_MESSAGE, channelId: OTHER_CHANNEL_ID })
			]);
		});

		it("keeps the row and its identifying facts while content and attachment metadata disappear", async () => {
			const outcome = await subject.store.tombstoneMessages(
				tombstoneWrite([MESSAGE_ID], { deletedAt: DELETED_AT })
			);
			expect(outcome).toEqual({
				messagesTombstoned: 1,
				attachmentsRemoved: 1,
				alreadyTombstoned: 0,
				unknownMessageIds: [],
				batches: 1
			});

			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(2);
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(0);

			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored).not.toBeNull();
			expect(stored?.messageId).toBe(MESSAGE_ID);
			expect(stored?.authorId).toBeDefined();
			expect(stored?.createdInstant).toEqual(CREATED_AT);
			expect(stored?.editedInstant).toEqual(EDITED_AT);
			expect(stored?.deletedAt).toEqual(DELETED_AT);
			expect(stored?.content).toBeNull();

			const { rows } = await subject.pool.query<{ content: string | null; author_id: string }>(
				"SELECT content, author_id FROM message WHERE message_id = $1",
				[BigInt(MESSAGE_ID)]
			);
			expect(rows[0]?.content).toBeNull();
			expect(rows[0]?.author_id).toBeDefined();
		});

		it("changes nothing on a replay of the deletion, and keeps the first tombstone instant", async () => {
			await subject.store.tombstoneMessages(tombstoneWrite([MESSAGE_ID], { deletedAt: DELETED_AT }));
			const replay = await subject.store.tombstoneMessages(
				tombstoneWrite([MESSAGE_ID], { deletedAt: LATER_EDIT_AT })
			);

			expect(replay).toMatchObject({ messagesTombstoned: 0, alreadyTombstoned: 1, attachmentsRemoved: 0 });
			expect((await subject.store.findMessage(GUILD_ID, MESSAGE_ID))?.deletedAt).toEqual(DELETED_AT);
		});

		it("reports the ids it had no row for instead of writing a tombstone out of nothing", async () => {
			const outcome = await subject.store.tombstoneMessages(
				tombstoneWrite([MESSAGE_ID, "160000000000000777"], { deletedAt: DELETED_AT })
			);

			expect(outcome).toMatchObject({
				messagesTombstoned: 1,
				unknownMessageIds: ["160000000000000777"]
			});
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(2);
		});

		it("will not let a create or an edit that arrives after the tombstone put content back", async () => {
			await subject.store.tombstoneMessages(tombstoneWrite([MESSAGE_ID]));

			const resurrected = await subject.store.upsertMessages([
				messageWrite({ messageId: MESSAGE_ID, content: "text from a late backfill page" })
			]);
			expect(resurrected).toMatchObject({ rowsWritten: 0, rowsSkipped: 1 });

			const edited = await subject.store.applyMessageEdit({
				guildId: GUILD_ID,
				messageId: MESSAGE_ID,
				content: "text from a late edit",
				editedInstant: LATER_EDIT_AT,
				messageType: null,
				attachments: [attachment(ATTACHMENT_ONE)]
			});
			expect(edited.status).toBe("tombstoned");

			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.content).toBeNull();
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(0);
		});

		it("tombstones a bulk deletion's ids in bounded batches and counts every one", async () => {
			const bulk = await openSubject("ingestion_bulk_delete", { writeBatchSize: 2 });
			// Ids are built as `bigint` text, never as JavaScript numbers: 1.6e17 is past the safe integer
			// range, and `+ index` on a number would silently repeat the same id.
			const ids = Array.from({ length: 5 }, (_unused, index) => (160000000000000600n + BigInt(index)).toString());
			await bulk.store.upsertMessages(ids.map((messageId) => messageWrite({ messageId, channelId: CHANNEL_ID })));

			const outcome = await bulk.store.tombstoneMessages(tombstoneWrite(ids, { deletedAt: DELETED_AT }));

			expect(outcome).toMatchObject({ messagesTombstoned: 5, alreadyTombstoned: 0, batches: 3 });
			expect(await rowCount(bulk.pool, "SELECT COUNT(*) AS total FROM message WHERE deleted_at IS NULL")).toBe(0);
			await bulk.database.close();
		});
	});

	describe("R6 — a structural change excludes a channel's or thread's messages in bulk", () => {
		beforeEach(async () => {
			await subject.store.upsertMessages([
				messageWrite({
					messageId: GUILD_ONE_MESSAGE,
					channelId: CHANNEL_ID,
					attachments: [attachment(ATTACHMENT_ONE)]
				}),
				messageWrite({ messageId: THREAD_MESSAGE, channelId: THREAD_ID }),
				messageWrite({ messageId: OTHER_CHANNEL_MESSAGE, channelId: OTHER_CHANNEL_ID })
			]);
		});

		it("tombstones every message of the named channel ids and leaves the rest of the guild intact", async () => {
			const outcome = await subject.store.excludeChannelMessages({
				guildId: GUILD_ID,
				channelIds: [CHANNEL_ID],
				deletedAt: DELETED_AT
			});

			expect(outcome).toMatchObject({ messagesTombstoned: 1, attachmentsRemoved: 1, batches: 1 });
			expect((await subject.store.findMessage(GUILD_ID, GUILD_ONE_MESSAGE))?.deletedAt).toEqual(DELETED_AT);
			expect((await subject.store.findMessage(GUILD_ID, OTHER_CHANNEL_MESSAGE))?.deletedAt).toBeNull();
			expect((await subject.store.findMessage(GUILD_ID, OTHER_CHANNEL_MESSAGE))?.content).toBe(SECRET_CONTENT);
		});

		it("covers a thread's messages only when the thread's own id is named, since that is what a post carries", async () => {
			await subject.store.excludeChannelMessages({
				guildId: GUILD_ID,
				channelIds: [CHANNEL_ID],
				deletedAt: DELETED_AT
			});
			expect((await subject.store.findMessage(GUILD_ID, THREAD_MESSAGE))?.deletedAt).toBeNull();

			await subject.store.excludeChannelMessages({
				guildId: GUILD_ID,
				channelIds: [THREAD_ID],
				deletedAt: DELETED_AT
			});
			expect((await subject.store.findMessage(GUILD_ID, THREAD_MESSAGE))?.deletedAt).toEqual(DELETED_AT);
		});

		it("is scoped to the guild, so an id shared with another guild's channel cannot be swept (R1)", async () => {
			const foreign = await subject.store.excludeChannelMessages({
				guildId: OTHER_GUILD_ID,
				channelIds: [CHANNEL_ID, THREAD_ID, OTHER_CHANNEL_ID],
				deletedAt: DELETED_AT
			});

			expect(foreign.messagesTombstoned).toBe(0);
			expect(
				await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message WHERE deleted_at IS NOT NULL")
			).toBe(0);
		});

		it("walks every page of a channel that holds more messages than the page bound", async () => {
			const bounded = await openSubject("ingestion_exclusion_pages", { exclusionPageSize: 2 });
			const ids = Array.from({ length: 5 }, (_unused, index) => (160000000000000700n + BigInt(index)).toString());
			await bounded.store.upsertMessages(
				ids.map((messageId) => messageWrite({ messageId, channelId: CHANNEL_ID }))
			);

			const outcome = await bounded.store.excludeChannelMessages({
				guildId: GUILD_ID,
				channelIds: [CHANNEL_ID],
				deletedAt: DELETED_AT
			});

			expect(outcome.messagesTombstoned).toBe(5);
			expect(outcome.batches).toBe(3);
			expect(await rowCount(bounded.pool, "SELECT COUNT(*) AS total FROM message WHERE deleted_at IS NULL")).toBe(
				0
			);
			await bounded.database.close();
		});

		it("is idempotent: a second exclusion of the same channels sweeps nothing and costs one statement", async () => {
			const first = await subject.store.excludeChannelMessages({
				guildId: GUILD_ID,
				channelIds: [CHANNEL_ID, THREAD_ID],
				deletedAt: DELETED_AT
			});
			const second = await subject.store.excludeChannelMessages({
				guildId: GUILD_ID,
				channelIds: [CHANNEL_ID, THREAD_ID],
				deletedAt: LATER_EDIT_AT
			});

			expect(first.messagesTombstoned).toBe(2);
			expect(second.messagesTombstoned).toBe(0);
			expect(second.batches).toBe(0);
		});
	});

	describe("bounded writes leave nothing half-applied", () => {
		it("rolls the whole batch back when one row of it cannot be written, attachments included", async () => {
			// Two deliveries of one message id inside one batch: PostgreSQL refuses an `ON CONFLICT DO UPDATE`
			// that would touch a row twice, and the refusal lands after the statement has already been asked to
			// write the second message's attachment metadata. Either row surviving would be a half-applied batch.
			const first = messageWrite({ messageId: MESSAGE_ID, channelId: CHANNEL_ID });
			const duplicate = { ...first, attachments: [attachment(ATTACHMENT_ONE)] };
			const other = messageWrite({
				messageId: GUILD_TWO_MESSAGE,
				attachments: [attachment(ATTACHMENT_TWO)]
			});

			await expect(subject.store.upsertMessages([duplicate, first, other])).rejects.toMatchObject({
				code: "21000"
			});

			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message")).toBe(0);
			expect(await rowCount(subject.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(0);
		});

		it("keeps the message row and drops nothing when the attachment insert of a tombstone sweep fails", async () => {
			// An attachment bound that cannot land in the composite key's guild: the FK refuses it, and the
			// whole transaction must go back to the state before the sweep started.
			await subject.store.upsertMessages([
				messageWrite({ messageId: MESSAGE_ID, attachments: [attachment(ATTACHMENT_ONE)] })
			]);

			await expect(
				subject.pool.query("BEGIN").then(async () => {
					await subject.pool.query(RAW_ATTACHMENT_INSERT, [
						BigInt(MESSAGE_ID),
						BigInt(ATTACHMENT_TWO),
						BigInt(OTHER_GUILD_ID),
						"x.pdf",
						"https://cdn.example/x.pdf",
						1
					]);
					await subject.pool.query("ROLLBACK");
				})
			).rejects.toMatchObject({ code: "23503" });

			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.content).toBe(SECRET_CONTENT);
			expect(stored?.attachments.map((row) => row.attachmentId)).toEqual([ATTACHMENT_ONE]);
		});
	});

	describe("the read path a tombstone must never serve", () => {
		it("hands a caller no message text, no filename and no URL for a tombstoned row (R12 there)", async () => {
			await subject.store.upsertMessages([
				messageWrite({ messageId: MESSAGE_ID, attachments: [attachment(ATTACHMENT_ONE)] })
			]);
			await subject.store.tombstoneMessages(tombstoneWrite([MESSAGE_ID]));

			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			const serialized = JSON.stringify(stored);
			expect(serialized).not.toContain(SECRET_CONTENT);
			expect(serialized).not.toContain(SECRET_FILENAME);
			expect(serialized).not.toContain(SECRET_URL);
			// What ADR-0007 retains is the author's identity, not the text the author wrote: the username
			// stays, and everything that was ever displayed to a reader is gone.
			expect(serialized).toContain(AUTHOR_ID);
			expect(stored?.deletedAt).toEqual(DELETED_AT);
		});
	});

	describe("nothing but application types crosses the persistence boundary", () => {
		it("hands back the contract's own camelCase record, with no column name and no driver field in it", async () => {
			const written = await subject.store.upsertMessages([
				messageWrite({
					messageId: MESSAGE_ID,
					editedInstant: EDITED_AT,
					attachments: [attachment(ATTACHMENT_ONE)]
				})
			]);
			const stored = await subject.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored).not.toBeNull();
			const firstAttachment = stored?.attachments[0];
			expect(firstAttachment).toBeDefined();

			// The whole point of the mapping layer: what a caller holds is the contract's record, field for field,
			// and nothing else came through with it (docs/architecture/persistence.md: no `QueryResult`, no rows).
			expect(Object.keys(stored ?? {}).sort()).toEqual(
				[
					"authorId",
					"authorIsBot",
					"authorUsername",
					"attachments",
					"channelId",
					"content",
					"createdInstant",
					"deletedAt",
					"editedInstant",
					"guildId",
					"messageId",
					"messageType",
					"replyReference",
					"webhookId"
				].sort()
			);
			expect(Object.keys(firstAttachment ?? {}).sort()).toEqual(
				["attachmentId", "contentType", "filename", "sizeBytes", "url"].sort()
			);

			// No snake_case column and no driver field survived the conversion, anywhere in the structure.
			const serialized = JSON.stringify(stored);
			for (const leaked of [
				"message_id",
				"guild_id",
				"created_instant",
				"size_bytes",
				"rowCount",
				"rows",
				"command"
			]) {
				expect(serialized).not.toContain(leaked);
			}

			// The write result is counts, which is the only thing a repository may report about a statement.
			expect(Object.keys(written).sort()).toEqual(
				["attachmentsRemoved", "attachmentsWritten", "batches", "rowsSkipped", "rowsWritten"].sort()
			);
			expect(Object.keys(written).every((key) => typeof written[key as keyof typeof written] === "number")).toBe(
				true
			);
		});

		it("reports a deletion as contract counts and unknown ids as strings, never as driver rows", async () => {
			await subject.store.upsertMessages([messageWrite({ messageId: MESSAGE_ID })]);

			const outcome = await subject.store.tombstoneMessages(tombstoneWrite([MESSAGE_ID, "160000000000000777"]));
			expect(Object.keys(outcome).sort()).toEqual(
				["alreadyTombstoned", "attachmentsRemoved", "batches", "messagesTombstoned", "unknownMessageIds"].sort()
			);
			// The ids the store never had come back as the strings they were sent as: no coercion into a number
			// that would silently change them, and no row objects attached to the report.
			expect(outcome.unknownMessageIds).toEqual(["160000000000000777"]);
			expect(outcome.unknownMessageIds.every((id) => typeof id === "string")).toBe(true);
		});
	});
});
