/**
 * RED — R15: the `initialize` instructions teach the agent how to connect and read, composed per
 * connection from the declared brand/metadata configuration (docs/features/query.md R15, O10).
 */
import { describe, expect, it, vi } from "vitest";
import { QueryToolsAdapter } from "../../../src/features/query/mcp/query-tools.adapter.js";
import { GetServerMetadataQuery } from "../../../src/features/query/queries/get-server-metadata.query.js";
import { QUERY_TOOL_SCHEMAS } from "../../../src/features/query/models/dtos/tool-schema.dto.js";
import type { AppLogger } from "../../../src/shared/logging/logger.interface.js";

const logger: AppLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => logger };
const identity = { userId: "333333333333333333", sessionId: "resolved-session", expiresAt: new Date("2099-01-01") };
const guildId = "111111111111111111";
const channelId = "222222222222222222";
const messageContent = "a secret message body";

function metadataQuery(options: { guildName?: string; locale?: "es" | "en"; status?: "current" | "incomplete" }) {
	const { guildName = "Fixture Guild", locale, status = "current" } = options;
	return new GetServerMetadataQuery(
		{ execute: async () => ({ status, guildId }) },
		{ execute: async () => ({ status: "registered", guild: { guildId, guildName } }) },
		logger,
		"Acme Hub",
		locale
	);
}

function adapterFor(metadata: GetServerMetadataQuery) {
	const unused = vi.fn(async () => ({ data: [] }));
	return new QueryToolsAdapter(
		{
			search_messages: { execute: unused },
			list_channels: { execute: unused },
			get_channel_history: { execute: unused },
			get_thread_messages: { execute: unused },
			get_message_context: { execute: unused },
			get_recent_activity: { execute: unused },
			get_hub_status: { execute: unused }
		},
		metadata
	);
}

async function initialize(metadata: GetServerMetadataQuery) {
	const result = await adapterFor(metadata).handle(
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
		identity
	);
	if (typeof result !== "object" || result === null || !("result" in result)) throw new Error("no result");
	const payload = (result as { result: { instructions?: unknown } }).result;
	if (typeof payload.instructions !== "string") throw new Error("no instructions");
	return payload.instructions;
}

describe("instructions-flag-short-list", () => {
	// R15's mirror-scope block (docs/features/query.md R15, amended 2026-11-12; owner decision D5, S3). The
	// observed failure was a client comparing a short `list_channels` page with an older, longer one and
	// reporting "algo falla en la paginación"; the connect-time text must say the subset is on purpose.
	const EN = {
		mirrorsPart: "this hub mirrors only part of the Guild",
		subsetOnPurpose: "`list_channels` lists a subset on purpose",
		notDefect: "a short list is not a pagination defect",
		verify: "call `get_hub_status` for the mirror scope (visibleAndMirroredChannelCount)"
	};
	const ES = {
		mirrorsPart: "este hub replica solo una parte del Guild",
		subsetOnPurpose: "`list_channels` lista un subconjunto a propósito",
		notDefect: "una lista corta no es un fallo de paginación",
		verify: "llama a `get_hub_status` para ver el alcance del espejo (visibleAndMirroredChannelCount)"
	};

	it.each([
		["en", EN],
		["es", ES]
	] as const)("states the mirror scope in %s", async (locale, facts) => {
		const text = await initialize(metadataQuery({ locale }));
		expect(text).toContain(facts.mirrorsPart);
		expect(text).toContain(facts.subsetOnPurpose);
		expect(text).toContain(facts.notDefect);
		expect(text).toContain(facts.verify);
	});

	it("keeps every existing block and carries no id or content", async () => {
		const text = await initialize(metadataQuery({ locale: "en" }));
		// The five pre-amendment blocks are intact beside the new one (R15's history note).
		for (const fact of [
			`Guild "Fixture Guild" (Guild id ${guildId})`,
			"OAuth",
			"protected-resource metadata",
			"ask the human to complete the Discord browser login",
			"ask them before calling",
			"no per-user read state",
			"recent-first",
			"page backward with the cursor",
			"limited by the person's Discord permissions",
			"no tool mutates anything"
		])
			expect(text).toContain(fact);
		expect(text).not.toContain(identity.userId);
		expect(text).not.toContain(channelId);
		expect(text).not.toContain(messageContent);
	});

	it("the list_channels description carries the same fact", () => {
		const listChannels = QUERY_TOOL_SCHEMAS.find((tool) => tool.name === "list_channels");
		if (!listChannels) throw new Error("missing list_channels schema");
		expect(listChannels.description).toContain("A short list is this hub's mirror scope");
		expect(listChannels.description).toContain("not a pagination defect");
		expect(listChannels.description).toContain("get_hub_status reports how many entries that is");
	});
});

describe("instructions-teach-agent", () => {
	it("teaches identity, first connect, novelty, history and honesty in the configured locale", async () => {
		const text = await initialize(metadataQuery({ locale: "en" }));
		expect(text).toContain("Acme Hub");
		expect(text).toContain(`Guild "Fixture Guild" (Guild id ${guildId})`);
		expect(text).toContain("OAuth");
		expect(text).toContain("401");
		expect(text).toContain("protected-resource metadata");
		expect(text).toContain("ask the human to complete the Discord browser login");
		expect(text).toContain("present the link and wait for them");
		expect(text).toContain("Never retry the request, re-probe the URL or invent a result");
		expect(text).toContain("get_recent_activity");
		expect(text).toContain("ask them before calling");
		expect(text).toContain('since: "1970-01-01T00:00:00Z"');
		expect(text).toContain("no per-user read state");
		expect(text).toContain("recent-first");
		expect(text).toContain("page backward with the cursor");
		expect(text).toContain("from/to");
		expect(text).toContain("get_message_context");
		expect(text).toContain("search_messages");
		expect(text).toContain(
			"list_channels lists only the channels and threads that both the person and the bot can see"
		);
		expect(text).toContain("limited by the person's Discord permissions");
		expect(text).toContain("not reported as nonexistent");
		expect(text).toContain("no tool mutates anything");
	});

	it("composes the configured locale and falls back to English when none is set", async () => {
		const spanish = await initialize(metadataQuery({ guildName: "Gremio Ficticio", locale: "es" }));
		expect(spanish).toContain("inicio de sesión de Discord en el navegador");
		expect(spanish).toContain("pregúntale antes de llamar");
		expect(spanish).toContain("de lo más reciente a lo más antiguo");
		expect(spanish).toContain(`Guild "Gremio Ficticio" (Guild id ${guildId})`);
		expect(spanish).not.toContain("ask them before calling");
		expect(await initialize(metadataQuery({ guildName: "Gremio Ficticio" }))).toContain("ask them before calling");
	});

	it("carries no user id, no channel id and no message content", async () => {
		const text = await initialize(metadataQuery({ locale: "en" }));
		expect(text).not.toContain(identity.userId);
		expect(text).not.toContain(channelId);
		expect(text).not.toContain(messageContent);
		// The Guild id R15 requires is the only identifier the text may carry.
		expect(text.match(/[1-9][0-9]{9,18}/g)).toEqual([guildId]);
	});

	it("uses R8's unidentified-Guild wording while the registry is not current, without failing the connection", async () => {
		const text = await initialize(
			metadataQuery({ guildName: "Fixture Guild", locale: "en", status: "incomplete" })
		);
		expect(text).toContain("Guild not yet identified");
		expect(text).not.toContain("Fixture Guild");
		expect(text).toContain("get_recent_activity");
	});
});
