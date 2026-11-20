import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { RecordMessageCommand } from "../../src/features/ingestion/commands/record-message.command.js";
import type { RecordMessageEvent } from "../../src/features/ingestion/commands/record-message.command.js";
import { ApplyMessageEditCommand } from "../../src/features/ingestion/commands/apply-message-edit.command.js";
import type { ApplyMessageEditEvent } from "../../src/features/ingestion/commands/apply-message-edit.command.js";
import { ApplyMessageDeletionCommand } from "../../src/features/ingestion/commands/apply-message-deletion.command.js";
import type { ApplyMessageDeletionEvent } from "../../src/features/ingestion/commands/apply-message-deletion.command.js";
import { createIngestionConfig } from "../../src/features/ingestion/config/ingestion-config.interface.js";
import { PostgresMessageStoreRepository } from "../../src/features/ingestion/repositories/postgres-message-store.repository.js";
import type { MessageAttachmentMetadata } from "../../src/features/discord/index.js";
import { DiscordRestGateway } from "../../src/features/discord/gateways/discord-rest.gateway.js";
import { RecordingLogger as DiscordRecordingLogger } from "../features/discord/fakes/recording-logger.js";
import { fakeClock, fakeWait } from "../features/discord/fakes/fake-discord-gateway-client.js";
import {
	FakeDiscordRestTransport,
	restOk,
	restServerError
} from "../features/discord/fakes/fake-discord-rest-transport.js";
import { messagePayload } from "../features/discord/fakes/rest-harness.js";
import { RecordingLogger } from "../features/ingestion/fakes/recording-logger.js";
import { payloadOf, withoutKey } from "../features/ingestion/fakes/payload-shape.js";
import {
	ATTACHMENT_ID,
	AUTHOR_ID,
	CHANNEL_ID,
	CREATED_AT,
	EDITED_AT,
	GUILD_ID,
	LATER_EDIT_AT,
	MESSAGE_ID,
	OTHER_GUILD_ID,
	SECRET_CONTENT,
	SECRET_FILENAME,
	SECRET_URL,
	SECRET_USERNAME,
	THREAD_ID
} from "../features/ingestion/fakes/message-fixtures.js";

/**
 * T2 evidence — message event application against a real PostgreSQL, with the real Discord REST adapter under
 * the scripted transport.
 *
 * The doubles prove what a command decided; this file proves the four things only a server and a real adapter
 * can prove:
 *
 * - **The lifecycle lands in the tables.** create → edit → tombstone, with the attachment rows replaced by the
 *   edit and physically deleted by the deletion, read back from `message` and `message_attachment` rather than
 *   from a projection (docs/features/ingestion.md R4, R5, R6; ADR-0007).
 * - **R5's reconciliation is a real REST read.** A partial update goes through `GET /channels/{id}/messages/{id}`
 *   on the actual adapter — its timeout, its attempt budget, its payload validation — and what lands is what the
 *   scripted response said, not what the event guessed. When that read fails, the stored row is untouched, on
 *   the server, with the columns to prove nothing moved.
 * - **Idempotency and no-regression are read back**, not inferred from a returned count: a replayed create
 *   leaves one row and one attachment, and an older edit instant leaves the newer text in the column (R7, R8).
 * - **A foreign-Guild event writes nothing at all**, which on a real server means zero rows and zero requests,
 *   not zero reported writes (R1).
 *
 * No test here contacts Discord: the adapter runs on `FakeDiscordRestTransport`, the seam `docs/features/discord.md`
 * defines for exactly this purpose.
 *
 * Without `TEST_DATABASE_URL` this suite is skipped and the harness prints the UNAVAILABLE banner; skipped is
 * missing evidence, never a pass.
 */

const MESSAGE_TWO = "160000000000000402";
const MESSAGE_THREE = "160000000000000403";
const MESSAGE_FOUR = "160000000000000404";
const MESSAGE_FIVE = "160000000000000405";
const NEVER_SEEN = "160000000000000777";
const ATTACHMENT_TWO = "160000000000000502";
const REPLIED_MESSAGE_ID = "160000000000000409";
const OBSERVED_AT = new Date("2026-03-04T09:00:00.000Z");
/** The text the scripted REST response carries: the reconciled state, and a log-safety secret too. */
const REST_RECONCILED_CONTENT = "the whole text as Discord REST reports it";

/** The server half: one isolated database, one real message store over it. */
interface Fixture {
	readonly database: IsolatedTestDatabase;
	readonly pool: Pool;
	readonly store: PostgresMessageStoreRepository;
}

/** The wiring half: rebuilt per case so the transport's calls and the log transcript belong to one case. */
interface Wiring {
	readonly record: RecordMessageCommand;
	readonly edit: ApplyMessageEditCommand;
	readonly remove: ApplyMessageDeletionCommand;
	readonly transport: FakeDiscordRestTransport;
	readonly logger: RecordingLogger;
	readonly restLogger: DiscordRecordingLogger;
}

describe.skipIf(!HAS_TEST_DATABASE)("ingestion message events (real PostgreSQL)", () => {
	let fixture: Fixture;
	let wire: Wiring;

	beforeAll(async () => {
		fixture = await openFixture("ingestion_message_events");
	}, 180_000);

	afterAll(async () => {
		// Best effort: a failed case must not leak a database into the shared server.
		await fixture?.database.close();
	});

	beforeEach(async () => {
		await fixture.database.resetMessageStore();
		wire = mountWiring(fixture.store);
	});

	/**
	 * One isolated database, migrated by the same runner `npm run migrate` uses. `writeBatchSize` is settable
	 * because one case needs to see the store's own bound at work, and a bound of 200 hides it.
	 */
	async function openFixture(label: string, writeBatchSize = 200): Promise<Fixture> {
		const database = await openIsolatedTestDatabase(label);
		return {
			database,
			pool: database.pool,
			store: new PostgresMessageStoreRepository({
				executor: database.executor,
				writeBatchSize,
				exclusionPageSize: 200
			})
		};
	}

	/**
	 * The composition under test: the real discord REST adapter on the scripted transport, and the three commands
	 * wired over the same configuration the feature module will use. Nothing is stubbed except Discord's HTTP and
	 * the instant the deletion observes. A fresh transport per case is what lets "no read was spent" be a real
	 * assertion rather than an arithmetic one.
	 */
	function mountWiring(store: PostgresMessageStoreRepository): Wiring {
		const transport = new FakeDiscordRestTransport();
		const restLogger = new DiscordRecordingLogger();
		const timing = fakeClock();
		const waiter = fakeWait();
		const rest = new DiscordRestGateway({
			transport,
			guildId: GUILD_ID,
			// The v1 bounds, so the reconciliation is bounded by the policy the discord feature pins.
			policy: {
				timeoutMs: 1_000,
				maxAttempts: 3,
				baseDelayMs: 100,
				factor: 2,
				maxDelayMs: 1_000,
				budgetMs: 3_000,
				maxSingleWaitMs: 2_000,
				memberPageSize: 1_000,
				memberMaxPages: 20,
				messagePageSize: 100,
				threadMemberPageSize: 100
			},
			logger: restLogger,
			clock: timing.clock,
			wait: waiter.wait
		});
		const logger = new RecordingLogger();
		const config = createIngestionConfig({ guildId: GUILD_ID });
		return {
			transport,
			logger,
			restLogger,
			record: new RecordMessageCommand({ config, messageStore: store, logger }),
			edit: new ApplyMessageEditCommand({ config, messageStore: store, messageRest: rest, logger }),
			remove: new ApplyMessageDeletionCommand({ config, messageStore: store, logger, clock: () => OBSERVED_AT })
		};
	}

	/** One count read back from the real tables: the evidence a lifecycle claim is checked against. */
	async function rowCount(
		pool: Pool = fixture.pool,
		statement: string,
		parameters: readonly unknown[] = []
	): Promise<number> {
		const { rows } = await pool.query<{ total: string }>(statement, [...parameters]);
		return Number(rows[0]?.total ?? "0");
	}

	/**
	 * The row as the table holds it. `pg` reports `bigint` as a string, which is what makes this read-back the
	 * strongest evidence in the file: nothing here passes through a repository projection.
	 */
	async function rawMessageRow(messageId: string): Promise<Record<string, unknown> | null> {
		const { rows } = await fixture.pool.query<Record<string, unknown>>(
			`SELECT message_id, guild_id, channel_id, author_id, message_type, content, created_instant,
				edited_instant, deleted_at
			FROM message WHERE message_id = $1`,
			[messageId]
		);
		return rows[0] ?? null;
	}

	function createEvent(overrides: Partial<RecordMessageEvent> = {}): RecordMessageEvent {
		return {
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			authorId: AUTHOR_ID,
			authorUsername: SECRET_USERNAME,
			authorIsBot: false,
			messageType: "default",
			content: SECRET_CONTENT,
			createdInstant: CREATED_AT,
			...overrides
		};
	}

	/** An update that carries what an update carries: ids, and by default nothing else (R5's partial shape). */
	function editEvent(overrides: Partial<ApplyMessageEditEvent> = {}): ApplyMessageEditEvent {
		return { guildId: GUILD_ID, messageId: MESSAGE_ID, channelId: CHANNEL_ID, ...overrides };
	}

	function deletionEvent(overrides: Partial<ApplyMessageDeletionEvent> = {}): ApplyMessageDeletionEvent {
		return { guildId: GUILD_ID, channelId: CHANNEL_ID, messageIds: [MESSAGE_ID], ...overrides };
	}

	/** A message body in Discord's own wire shape, under the channel this suite reads it from. */
	function restMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return messagePayload(MESSAGE_ID, {
			channel_id: CHANNEL_ID,
			content: REST_RECONCILED_CONTENT,
			timestamp: CREATED_AT.toISOString(),
			edited_timestamp: EDITED_AT.toISOString(),
			...overrides
		});
	}

	function messagePath(messageId: string = MESSAGE_ID, channelId: string = CHANNEL_ID): string {
		return `/channels/${channelId}/messages/${messageId}`;
	}

	/** Attachment metadata as the event reports it: `contentType` present or absent is a real distinction (R11). */
	function reportedAttachment(attachmentId: string = ATTACHMENT_ID): MessageAttachmentMetadata {
		return { attachmentId, filename: SECRET_FILENAME, url: SECRET_URL, sizeBytes: 1_048_576 };
	}

	describe("the lifecycle over the real tables (R4, R5, R6)", () => {
		it("creates, edits and deletes one message, landing every state in the columns", async () => {
			const attachment: MessageAttachmentMetadata = {
				...reportedAttachment(),
				contentType: "application/pdf"
			};

			const created = await wire.record.execute(
				createEvent({
					attachments: [attachment],
					messageType: "reply",
					replyReference: { messageId: REPLIED_MESSAGE_ID, channelId: CHANNEL_ID }
				})
			);
			expect(created).toMatchObject({ status: "applied", rowsWritten: 1, attachmentsWritten: 1 });
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(1);

			const edited = await wire.edit.execute(editEvent({ content: "the edited text", editedInstant: EDITED_AT }));
			expect(edited).toMatchObject({ status: "applied", reconciled: false, storedEditedInstant: EDITED_AT });

			const beforeDelete = await fixture.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(beforeDelete).toMatchObject({ content: "the edited text", editedInstant: EDITED_AT });

			const deleted = await wire.remove.execute(deletionEvent());
			expect(deleted).toMatchObject({ status: "applied", messagesTombstoned: 1, attachmentsRemoved: 1 });

			// ADR-0007 read back from the table: the text is gone from the column and the attachment row with it.
			const row = await rawMessageRow(MESSAGE_ID);
			expect(row?.["content"]).toBeNull();
			expect(row?.["deleted_at"]).toBeInstanceOf(Date);
			expect(row?.["author_id"]).toBe(AUTHOR_ID);
			expect(row?.["message_type"]).toBe("reply");
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(0);
			expect(
				await rowCount(
					fixture.pool,
					"SELECT COUNT(*) AS total FROM message WHERE content IS NULL AND deleted_at IS NOT NULL"
				)
			).toBe(1);
		});

		it("keeps a thread message under the thread's own id through the whole lifecycle (R2 there)", async () => {
			await wire.record.execute(createEvent({ channelId: THREAD_ID }));
			await wire.edit.execute(
				editEvent({ channelId: THREAD_ID, content: "edited in a thread", editedInstant: EDITED_AT })
			);
			await wire.remove.execute(deletionEvent({ channelId: THREAD_ID }));

			const row = await rawMessageRow(MESSAGE_ID);
			expect(row?.["channel_id"]).toBe(THREAD_ID);
			expect(row?.["content"]).toBeNull();
			expect(row?.["deleted_at"]).toBeInstanceOf(Date);
		});

		it("reads back the reply reference and the attachment metadata a create event carried (R4, R11)", async () => {
			await wire.record.execute(
				createEvent({
					attachments: [
						reportedAttachment(ATTACHMENT_TWO),
						{ ...reportedAttachment(ATTACHMENT_ID), contentType: "application/pdf" }
					],
					replyReference: { messageId: REPLIED_MESSAGE_ID, channelId: THREAD_ID, guildId: GUILD_ID }
				})
			);

			const stored = await fixture.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.replyReference).toEqual({
				messageId: REPLIED_MESSAGE_ID,
				channelId: THREAD_ID,
				guildId: GUILD_ID
			});
			// Ordered by attachment id, and each entry is metadata only — R11's bound holds on the server too,
			// because the table has nowhere to put bytes.
			expect(stored?.attachments).toEqual([
				{
					attachmentId: ATTACHMENT_ID,
					filename: SECRET_FILENAME,
					url: SECRET_URL,
					contentType: "application/pdf",
					sizeBytes: 1_048_576
				},
				{
					attachmentId: ATTACHMENT_TWO,
					filename: SECRET_FILENAME,
					url: SECRET_URL,
					contentType: null,
					sizeBytes: 1_048_576
				}
			]);
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(2);
		});
	});

	describe("a replay changes nothing, read back from the tables (R7)", () => {
		it("delivers one create event twice and leaves one row with one attachment", async () => {
			const event = createEvent({ attachments: [reportedAttachment()] });

			const first = await wire.record.execute(event);
			const second = await wire.record.execute(event);

			expect(first).toMatchObject({ rowsWritten: 1 });
			expect(second).toMatchObject({ status: "applied", rowsWritten: 0, rowsSkipped: 1 });
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(1);

			const stored = await fixture.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.content).toBe(SECRET_CONTENT);
			expect(stored?.attachments.map((row) => row.attachmentId)).toEqual([ATTACHMENT_ID]);
		});

		it("applies the same edit twice and keeps one edited instant, refusing the second as unchanged", async () => {
			await wire.record.execute(createEvent());

			const first = await wire.edit.execute(editEvent({ content: "the edited text", editedInstant: EDITED_AT }));
			const second = await wire.edit.execute(editEvent({ content: "the edited text", editedInstant: EDITED_AT }));

			expect(first.status).toBe("applied");
			expect(second).toMatchObject({ status: "refused", reason: "unchanged" });
			expect(
				await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message WHERE edited_instant = $1", [
					EDITED_AT
				])
			).toBe(1);
		});

		it("deletes the same message twice and keeps the first tombstone instant", async () => {
			await wire.record.execute(createEvent({ attachments: [reportedAttachment()] }));
			await wire.remove.execute(deletionEvent());

			const replay = await wire.remove.execute(deletionEvent());

			expect(replay).toMatchObject({ messagesTombstoned: 0, alreadyTombstoned: 1, attachmentsRemoved: 0 });
			expect((await fixture.store.findMessage(GUILD_ID, MESSAGE_ID))?.deletedAt).toEqual(OBSERVED_AT);
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(0);
		});
	});

	describe("convergence over arrival order, on the server (R5, R8)", () => {
		it("refuses an older edit that arrives after a newer one, leaving the newer text in the column", async () => {
			await wire.record.execute(createEvent({ content: "the first text" }));
			await wire.edit.execute(editEvent({ content: "the newest text", editedInstant: LATER_EDIT_AT }));

			const outcome = await wire.edit.execute(
				editEvent({ content: "a stale revision", editedInstant: EDITED_AT })
			);

			expect(outcome).toMatchObject({ status: "refused", reason: "stale" });
			const row = await rawMessageRow(MESSAGE_ID);
			expect(row?.["content"]).toBe("the newest text");
			expect(row?.["edited_instant"]).toEqual(LATER_EDIT_AT);
		});

		it("refuses a late create record of a pre-edit version that carries no edit instant at all", async () => {
			await wire.record.execute(createEvent({ content: "the first text" }));
			await wire.edit.execute(editEvent({ content: "the edited text", editedInstant: EDITED_AT }));

			const late = await wire.record.execute(
				withoutKey(createEvent({ content: "the pre-edit text" }), "editedInstant")
			);

			expect(late).toMatchObject({ rowsWritten: 0, rowsSkipped: 1 });
			expect((await rawMessageRow(MESSAGE_ID))?.["content"]).toBe("the edited text");
		});

		it("will not let any later event put content back on a tombstoned row (R6 terminal)", async () => {
			await wire.record.execute(createEvent());
			await wire.remove.execute(deletionEvent());

			const edited = await wire.edit.execute(
				editEvent({ content: "text from a late delivery", editedInstant: LATER_EDIT_AT })
			);
			const created = await wire.record.execute(createEvent({ content: "text from a late backfill page" }));

			expect(edited).toMatchObject({ status: "refused", reason: "tombstoned" });
			expect(created).toMatchObject({ rowsWritten: 0, rowsSkipped: 1 });
			expect((await rawMessageRow(MESSAGE_ID))?.["content"]).toBeNull();
		});
	});

	describe("a partial update is reconciled through a real REST read (R5)", () => {
		it("fetches the message by id and writes what the response said, replacing the attachment set", async () => {
			await wire.record.execute(createEvent({ content: "the first text", attachments: [reportedAttachment()] }));
			wire.transport.reply(
				messagePath(),
				restOk(
					restMessage({
						content: REST_RECONCILED_CONTENT,
						edited_timestamp: LATER_EDIT_AT.toISOString(),
						attachments: [
							{
								id: ATTACHMENT_TWO,
								filename: "after-the-edit.pdf",
								url: "https://cdn.discord.example/attachments/after-the-edit.pdf",
								size: 4_096,
								content_type: "application/pdf"
							}
						]
					})
				)
			);

			// The event carries the edit instant and nothing else: content is the field the read has to supply.
			const outcome = await wire.edit.execute(editEvent({ editedInstant: LATER_EDIT_AT }));

			expect(outcome).toMatchObject({
				status: "applied",
				reconciled: true,
				storedEditedInstant: LATER_EDIT_AT,
				attachmentsRemoved: 1,
				attachmentsWritten: 1
			});
			// One bounded request for one resource: the reconciliation is a by-id fetch, not a scan.
			expect(wire.transport.callsOn(messagePath())).toBe(1);
			expect(wire.transport.totalCalls()).toBe(1);
			expect(wire.transport.lastRequest().query).toEqual({});
			expect(wire.transport.lastRequest().operation).toBe("discord-rest.message");
			expect(wire.transport.timeouts).toEqual([1_000]);

			const stored = await fixture.store.findMessage(GUILD_ID, MESSAGE_ID);
			expect(stored?.content).toBe(REST_RECONCILED_CONTENT);
			expect(stored?.editedInstant).toEqual(LATER_EDIT_AT);
			expect(stored?.attachments).toEqual([
				{
					attachmentId: ATTACHMENT_TWO,
					filename: "after-the-edit.pdf",
					url: "https://cdn.discord.example/attachments/after-the-edit.pdf",
					contentType: "application/pdf",
					sizeBytes: 4_096
				}
			]);
		});

		it("reconciles a thread message through the thread's own path (R2 there)", async () => {
			await wire.record.execute(createEvent({ channelId: THREAD_ID, content: "the first text" }));
			wire.transport.reply(
				messagePath(MESSAGE_ID, THREAD_ID),
				restOk(restMessage({ channel_id: THREAD_ID, content: REST_RECONCILED_CONTENT }))
			);

			// The edit instant came with the event; the text did not, so the read is what completes the state.
			const outcome = await wire.edit.execute(editEvent({ channelId: THREAD_ID, editedInstant: EDITED_AT }));

			expect(outcome).toMatchObject({ status: "applied", reconciled: true });
			expect(wire.transport.callsOn(messagePath(MESSAGE_ID, THREAD_ID))).toBe(1);
			expect((await fixture.store.findMessage(GUILD_ID, MESSAGE_ID))?.content).toBe(REST_RECONCILED_CONTENT);
		});

		it("keeps the text the event carried when the read answered with an older revision (R8)", async () => {
			await wire.record.execute(createEvent({ content: "the first text" }));
			wire.transport.reply(messagePath(), restOk(restMessage({ content: "an older revision" })));

			// The event says what changed; the read completes only the field it did not carry.
			const outcome = await wire.edit.execute(
				withoutKey(
					editEvent({ content: "the text from the event", editedInstant: LATER_EDIT_AT }),
					"editedInstant"
				)
			);

			expect(outcome).toMatchObject({ status: "applied", reconciled: true });
			expect((await rawMessageRow(MESSAGE_ID))?.["content"]).toBe("the text from the event");
		});

		it("writes nothing when the read cannot be had, leaving the stored row exactly as it was (R5, R10)", async () => {
			await wire.record.execute(createEvent({ content: SECRET_CONTENT, attachments: [reportedAttachment()] }));
			const before = await rawMessageRow(MESSAGE_ID);
			for (let attempt = 0; attempt < 4; attempt += 1) {
				wire.transport.reply(messagePath(), restServerError());
			}

			const outcome = await wire.edit.execute(editEvent({ editedInstant: EDITED_AT }));

			expect(outcome).toMatchObject({
				status: "deferred",
				reason: "reconcile-unavailable",
				failure: { reason: "server-error", status: 500, attempts: 3 }
			});
			// Bounded: the adapter spent its attempt budget on one request path, and no write followed it.
			expect(wire.transport.callsOn(messagePath())).toBe(3);
			expect(await rawMessageRow(MESSAGE_ID)).toEqual(before);
			expect(
				await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message WHERE edited_instant IS NULL")
			).toBe(1);
		});

		it("refuses a response that names another message, so a reconciliation cannot land on the wrong row", async () => {
			await wire.record.execute(createEvent({ content: "the first text" }));
			wire.transport.reply(messagePath(), restOk(restMessage({ id: NEVER_SEEN })));

			const outcome = await wire.edit.execute(editEvent({ editedInstant: EDITED_AT }));

			expect(outcome).toMatchObject({ status: "deferred", failure: { reason: "validation", fieldPath: "id" } });
			const row = await rawMessageRow(MESSAGE_ID);
			expect(row?.["content"]).toBe("the first text");
			expect(row?.["edited_instant"]).toBeNull();
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
		});

		it("never spends a read on an update that already carries the whole state (R7 bounds)", async () => {
			await wire.record.execute(createEvent());

			const outcome = await wire.edit.execute(
				editEvent({ content: "the edited text", editedInstant: EDITED_AT })
			);

			expect(outcome).toMatchObject({ status: "applied", reconciled: false });
			expect(wire.transport.totalCalls()).toBe(0);
		});

		it("reports the missing fields and the boundary reason when a reconcile cannot be trusted", async () => {
			await wire.record.execute(createEvent({ content: "the first text" }));
			// A response that is a message except for the one field the command needed from it.
			wire.transport.reply(messagePath(), restOk(payloadOf<Record<string, unknown>>(restMessage(), ["content"])));

			const outcome = await wire.edit.execute(editEvent({ editedInstant: EDITED_AT }));

			expect(outcome).toMatchObject({
				status: "deferred",
				missingFields: ["content"],
				failure: { reason: "validation", fieldPath: "content" }
			});
			expect((await rawMessageRow(MESSAGE_ID))?.["content"]).toBe("the first text");
		});
	});

	describe("deletion, single and bulk, on real rows (R6)", () => {
		it("tombstones a bulk list in bounded batches and drops every attachment row with them", async () => {
			// A store whose write bound is two, so five ids is provably three statements rather than one big one.
			const bulk = await openFixture("ingestion_bulk_deletion", 2);
			const bulkWire = mountWiring(bulk.store);
			const ids = [MESSAGE_ID, MESSAGE_TWO, MESSAGE_THREE, MESSAGE_FOUR, MESSAGE_FIVE];
			for (const messageId of ids) {
				await bulkWire.record.execute(createEvent({ messageId, attachments: [reportedAttachment()] }));
			}
			expect(await rowCount(bulk.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(ids.length);

			const outcome = await bulkWire.remove.execute(deletionEvent({ messageIds: ids }));

			expect(outcome).toMatchObject({
				status: "applied",
				messagesTombstoned: ids.length,
				batches: 3,
				attachmentsRemoved: ids.length
			});
			expect(await rowCount(bulk.pool, "SELECT COUNT(*) AS total FROM message_attachment")).toBe(0);
			expect(await rowCount(bulk.pool, "SELECT COUNT(*) AS total FROM message WHERE content IS NOT NULL")).toBe(
				0
			);
			expect(
				await rowCount(bulk.pool, "SELECT COUNT(*) AS total FROM message WHERE deleted_at IS NOT NULL")
			).toBe(ids.length);
			await bulk.database.close();
		});

		it("counts the ids the store never had and writes no row for them (R4's error case)", async () => {
			await wire.record.execute(createEvent());

			const outcome = await wire.remove.execute(deletionEvent({ messageIds: [MESSAGE_ID, NEVER_SEEN] }));

			expect(outcome).toMatchObject({ messagesTombstoned: 1, unknownMessageIds: [NEVER_SEEN] });
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message")).toBe(1);
			expect(
				await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message WHERE message_id = $1", [
					NEVER_SEEN
				])
			).toBe(0);
		});

		it("refuses a deletion that names no id, leaving the table untouched (R6)", async () => {
			await wire.record.execute(createEvent());

			await expect(wire.remove.execute(deletionEvent({ messageIds: [] }))).rejects.toMatchObject({
				field: "message.message_ids"
			});
			expect(
				await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message WHERE deleted_at IS NOT NULL")
			).toBe(0);
		});
	});

	describe("the guild boundary and the log, over the real path (R1, R12)", () => {
		it("stores nothing and requests nothing for a foreign-guild create, edit or delete", async () => {
			const foreign = { guildId: OTHER_GUILD_ID };

			const created = await wire.record.execute(createEvent({ ...foreign, messageId: MESSAGE_TWO }));
			const edited = await wire.edit.execute(
				editEvent({ ...foreign, messageId: MESSAGE_TWO, content: SECRET_CONTENT, editedInstant: EDITED_AT })
			);
			const deleted = await wire.remove.execute(deletionEvent({ ...foreign, messageIds: [MESSAGE_TWO] }));

			expect(created).toMatchObject({ status: "dropped", reason: "foreign-guild" });
			expect(edited).toMatchObject({ status: "dropped", reason: "foreign-guild" });
			expect(deleted).toMatchObject({ status: "dropped", reason: "foreign-guild" });
			expect(await rowCount(fixture.pool, "SELECT COUNT(*) AS total FROM message")).toBe(0);
			expect(wire.transport.totalCalls()).toBe(0);
		});

		it("never writes message text, attachment metadata or the reconciled content to a log line", async () => {
			wire.transport.reply(messagePath(), restOk(restMessage({ content: REST_RECONCILED_CONTENT })));

			await wire.record.execute(createEvent({ attachments: [reportedAttachment()] }));
			await wire.edit.execute(editEvent({ content: SECRET_CONTENT, editedInstant: EDITED_AT }));
			await wire.edit.execute(withoutKey(editEvent({ editedInstant: LATER_EDIT_AT }), "content"));
			await wire.remove.execute(deletionEvent());

			const transcript = `${wire.logger.transcript()}\n${wire.restLogger.transcript()}`;
			for (const secret of [
				SECRET_CONTENT,
				SECRET_FILENAME,
				SECRET_URL,
				SECRET_USERNAME,
				REST_RECONCILED_CONTENT
			]) {
				expect(transcript).not.toContain(secret);
			}
			// What it does carry is the addressing and the counts a reviewer needs.
			expect(transcript).toContain(MESSAGE_ID);
			expect(transcript).toContain(CHANNEL_ID);
		});
	});
});
