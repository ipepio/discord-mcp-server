import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as discordSurface from "../../../src/features/discord/index.js";
import type { DiscordRestOperations } from "../../../src/features/discord/models/domain/discord-rest-gateway.interface.js";
import type { DiscordEventConsumer } from "../../../src/features/discord/models/domain/discord-event-stream.interface.js";
import type { DiscordStatusQuery } from "../../../src/features/discord/models/domain/discord-status.interface.js";
import { DiscordRestGateway } from "../../../src/features/discord/gateways/discord-rest.gateway.js";
import { DISCORD_REST_OPERATIONS } from "../../../src/features/discord/models/domain/discord-rest-operation.enum.js";
import { DiscordJsRestTransport } from "../../../src/features/discord/gateways/discord-rest.transport.gateway.js";
import type { DiscordRestTransport } from "../../../src/features/discord/gateways/discord-rest.gateway.interface.js";
import { GUILD_ID } from "./fakes/normalize.js";
import { restHarness } from "./fakes/rest-harness.js";
import { fakeConfig } from "./fakes/fake-discord-gateway-client.js";
import { restOk, FakeDiscordRestTransport } from "./fakes/fake-discord-rest-transport.js";

/**
 * R8 — the read-only property proved structurally instead of asserted in prose. The spec's proof for R8 is
 * a structural test: the adapter's discord.js usage calls no mutating method, and the public contract
 * exposes no write operation. Both halves are checked here, in the three ways a claim like this can fail:
 *
 * 1. the seams carry no write-shaped member at all (runtime shape of adapter, transport and fake);
 * 2. the contracts a consumer can reach name only reads (compile-time cover: adding a member forces this
 *    file to name it, and the name must start with `read`);
 * 3. the source that touches discord.js cannot reach a write verb, and no other file in the feature is
 *    allowed to import the library in the first place.
 */

/** Anchored on this file's own location, so the scan does not depend on the runner's working directory. */
const FEATURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "features", "discord");

/** Files inside this feature, as repo-relative paths, so a scan can name what it found. */
function featureSources(dir: string = FEATURE_ROOT): string[] {
	const found: string[] = [];

	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...featureSources(path));
			continue;
		}

		if (path.endsWith(".ts")) {
			found.push(path);
		}
	}

	return found;
}

function sourceOf(path: string): string {
	return readFileSync(path, "utf8");
}

/** Everything that could put a message, an edit or a deletion on the wire. */
const MUTATING_METHOD_NAMES = [
	"post",
	"put",
	"patch",
	"delete",
	"send",
	"sendMessage",
	"createMessage",
	"bulkDelete",
	"edit",
	"remove",
	"upsert",
	"save",
	"insert",
	"update",
	"destroy",
	"write"
] as const;

function writeShapedKeys(target: object): string[] {
	const names = new Set<string>();

	for (const key of Object.keys(target)) {
		names.add(key);
	}

	for (const key of Object.getOwnPropertyNames(target)) {
		names.add(key);
	}

	const prototype = Object.getPrototypeOf(target) as object | null;
	if (prototype !== null) {
		for (const key of Object.getOwnPropertyNames(prototype)) {
			names.add(key);
		}
	}

	return [...names].filter((name) => MUTATING_METHOD_NAMES.some((verb) => name.toLowerCase().includes(verb)));
}

describe("R8 structural proof — the REST seams expose no write", () => {
	it("the transport seam a request goes through carries one method: get", () => {
		const transport: DiscordRestTransport = new FakeDiscordRestTransport();

		expect(typeof transport.get).toBe("function");
		expect(writeShapedKeys(transport)).toEqual([]);
	});

	it("the REST adapter's callable members are the eight reads and its own plumbing, naming no write", () => {
		const h = restHarness();
		const callable = Object.entries(h.gateway)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.sort();

		// The eight reads are the whole public surface; the rest are private bounded-request plumbing.
		expect(callable).toEqual([
			"readBotIdentity",
			"readChannels",
			"readGuildSnapshot",
			"readMemberRoster",
			"readMessage",
			"readMessageHistoryPage",
			"readRoles",
			"readThreadMembers"
		]);
		expect(Object.getOwnPropertyNames(DiscordRestGateway.prototype).sort()).toEqual([
			"configuredGuildId",
			"constructor",
			"enqueue",
			"execute",
			"reportRetry",
			"requireResourceId",
			"truncated"
		]);
		expect(writeShapedKeys(h.gateway)).toEqual([]);
		// The eight reads are exactly the operations the boundary is allowed to name in a failure or a log.
		expect(callable).toHaveLength(DISCORD_REST_OPERATIONS.length);
	});
	it("the discord.js REST transport exposes get and nothing else", () => {
		const transport = new DiscordJsRestTransport(fakeConfig());
		const callable = Object.entries(transport as unknown as Record<string, unknown>)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name);

		expect(callable).toEqual(["get"]);
		expect(
			Object.getOwnPropertyNames(DiscordJsRestTransport.prototype).filter((name) => name !== "constructor")
		).toEqual([]);
		expect(writeShapedKeys(transport)).toEqual([]);
	});

	it("a request the seam can describe carries no body: only operation, path, query and timeout", async () => {
		const h = restHarness();
		h.transport.reply(`/guilds/${GUILD_ID}`, restOk({ id: GUILD_ID, name: "Example Guild HQ" }));

		await h.gateway.readGuildSnapshot();
		const request = h.transport.lastRequest();

		expect(Object.keys(request).sort()).toEqual(["operation", "path", "query", "timeoutMs"]);
	});

	it("every member of the public REST contract is a read (adding a write breaks this test at compile time)", () => {
		// `Record<keyof …>` is the cover: a new member of the contract must be listed here to compile.
		const restMembers: Record<keyof DiscordRestOperations, true> = {
			readGuildSnapshot: true,
			readRoles: true,
			readChannels: true,
			readMemberRoster: true,
			readThreadMembers: true,
			readMessageHistoryPage: true,
			readMessage: true
		};

		for (const name of Object.keys(restMembers)) {
			expect(name).toMatch(/^read[A-Z]/);
		}

		const consumerMembers: Record<keyof DiscordEventConsumer, true> = { subscribe: true };
		const statusMembers: Record<keyof DiscordStatusQuery, true> = { read: true };

		expect(Object.keys(consumerMembers)).toEqual(["subscribe"]);
		expect(Object.keys(statusMembers)).toEqual(["read"]);
	});

	it("no file in the feature other than the two discord.js boundaries imports the library", () => {
		const allowed = ["gateways/discord-rest.transport.gateway.ts", "gateways/discord.gateway.ts"].sort();
		const importers = featureSources()
			.filter((path) => /from "discord\.js"/.test(sourceOf(path)))
			.map((path) => relative(FEATURE_ROOT, path).replace(/\\/g, "/"))
			.sort();

		expect(importers).toEqual(allowed);
	});

	it("the code that reaches Discord REST names one HTTP verb, and it is get", () => {
		const transport = sourceOf(join(FEATURE_ROOT, "gateways", "discord-rest.transport.gateway.ts"));
		const calls = [...transport.matchAll(/this\.rest\.(?<verb>[A-Za-z]+)\(/g)]
			.map((match) => String(match.groups?.["verb"]))
			.sort();

		// `setToken` arms the credential on the client; it is not a request and writes nothing to Discord.
		expect(calls).toEqual(["get", "setToken"]);
		expect(transport).not.toMatch(/this\.rest\.(?:post|put|patch|delete)\(/);
	});

	it("the connection adapter uses the client for lifecycle and listening only (R1, R6)", () => {
		const client = sourceOf(join(FEATURE_ROOT, "gateways", "discord.gateway.ts"));
		const onClient = [...client.matchAll(/this\.client\.(?<verb>[A-Za-z]+)\(/g)].map((match) =>
			String(match.groups?.["verb"])
		);

		// `destroy` tears the socket down (R6); it is not a write to Discord. Continuing a session is the
		// library's own resumption, not a call this file makes, so nothing else appears here either.
		const listening = ["emit", "off", "on", "once", "removeAllListeners"];
		const lifecycle = ["connect", "destroy", "identify", "login", "resume", "startTyping"];
		const used = [...new Set(onClient)].filter((verb) => !listening.includes(verb)).sort();

		for (const verb of used) {
			expect(lifecycle, `${verb} is not a connection-lifecycle verb`).toContain(verb);
		}

		expect(used).toEqual(["destroy", "login"]);
		expect(client).not.toMatch(/\.send\(|\.edit\(|bulkDelete|\.delete\(|channels\.create|roles\.create/);
	});

	it("the public surface exports no publish path, no raw seam and no transport seam", () => {
		const exported = Object.keys(discordSurface).sort();

		for (const forbidden of [
			"DiscordEventProducer",
			"DiscordRestTransport",
			"DiscordRestTransportError",
			"DiscordJsRestTransport",
			"DiscordJsGatewayClientFactory",
			"DiscordGatewayClient",
			"RawDiscordEvent",
			"mapRawEvent",
			"DiscordEventIntakeGateway",
			"DiscordRestGateway",
			"DiscordConnectionGateway"
		]) {
			expect(exported).not.toContain(forbidden);
		}

		// What the barrel exports is data: tokens, enum-shaped maps, and classes named by the contract set.
		for (const [name, value] of Object.entries(discordSurface)) {
			if (typeof value === "string") {
				expect(name, `${name} is not a token`).toMatch(/^DISCORD_.*_TOKEN$/);
				continue;
			}

			if (typeof value === "object" && value !== null) {
				// An enum-shaped export carries no behaviour at all: nothing to call, so nothing to write.
				expect(
					Object.values(value).some((entry) => typeof entry === "function"),
					`${name} exports behaviour`
				).toBe(false);
				continue;
			}

			if (typeof value === "function" && value.prototype !== undefined) {
				const members = Object.getOwnPropertyNames(value.prototype as object).filter(
					(member) => member !== "constructor"
				);
				expect(
					members.filter((member) =>
						MUTATING_METHOD_NAMES.some((verb) => member.toLowerCase().includes(verb))
					),
					name
				).toEqual([]);
			}
		}
	});

	it("the barrel itself imports none of the feature's internals", () => {
		const barrel = sourceOf(join(FEATURE_ROOT, "index.ts"));
		const forbidden = [
			"gateways/discord.gateway.js",
			"gateways/discord.gateway.interface.js",
			"gateways/discord-rest.gateway.interface.js",
			"gateways/discord-rest.transport.gateway.js",
			"gateways/discord-event-intake.gateway.js",
			"models/mappers/"
		];

		for (const path of forbidden) {
			expect(barrel, `index.ts must not reach ${path}`).not.toContain(path);
		}
	});
});
