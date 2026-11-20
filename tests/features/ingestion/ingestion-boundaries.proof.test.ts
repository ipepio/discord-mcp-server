import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as surface from "../../../src/features/ingestion/index.js";
import { toHistoryMessageWrite } from "../../../src/features/ingestion/models/mappers/message-history.mapper.js";
import { RecordingMessageStore } from "./fakes/recording-message-store.js";
import { GUILD_ID, CHANNEL_ID, AUTHOR_ID, MESSAGE_ID, CREATED_AT, messageWrite } from "./fakes/message-fixtures.js";

function sources(path: string): string[] {
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sources(join(path, entry.name))
			: entry.name.endsWith(".ts")
				? [readFileSync(join(path, entry.name), "utf8")]
				: []
	);
}
describe("ingestion structural boundaries R10/R11", () => {
	it("has no model-processing, attachment byte transport or semantic dependencies", () => {
		const text = sources("src/features/ingestion").join("\n");
		const imports = text.match(/from\s+["'][^"']+["']/g) ?? [];
		expect(imports.join("\n")).not.toMatch(
			/openai|anthropic|embedding|langchain|axios|node:http|undici|discord\.js/i
		);
		expect(text).not.toMatch(/\bfetch\s*\(|\bBuffer\s*\.|\barrayBuffer\s*\(/);
	});
	it("exports only intentional composition and import surfaces, never SQL or read repositories", () => {
		expect(Object.keys(surface).sort()).toEqual(
			[
				"INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN",
				"INGESTION_BOUND_EVENT_KINDS",
				"INGESTION_EVENT_SUBSCRIPTION_TOKEN",
				"INGESTION_IMPORT_COMMAND_TOKEN",
				"ImportChannelHistoryCommand",
				"IngestionEventSubscription",
				"IngestionModule",
				// Composition-time parser for IMPORT_MODE/IMPORT_DAYS: configuration data, no store access.
				"loadIngestionImportWindow"
			].sort()
		);
	});
	it("replaying REST webhook history over an identical Gateway record moves nothing", async () => {
		const store = new RecordingMessageStore();
		const webhookId = "160000000000000700";
		const write = messageWrite({ webhookId, authorUsername: null, authorIsBot: null, content: "same" });
		await store.upsertMessages([write]);
		const mapped = toHistoryMessageWrite(GUILD_ID, {
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			authorId: AUTHOR_ID,
			content: "same",
			createdInstant: CREATED_AT,
			messageType: "default",
			webhookId
		});
		expect((await store.upsertMessages([mapped.write])).rowsWritten).toBe(0);
		expect(store.rows.get(MESSAGE_ID)?.webhookId).toBe(webhookId);
	});
});
