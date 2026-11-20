import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DiscordEventKind } from "../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import { DiscordConnectionStatus } from "../../../src/features/discord/models/domain/discord-connection-status.js";
import { DiscordStatusGateway } from "../../../src/features/discord/gateways/discord-status.gateway.js";
import { composeInstallation, messageFixture } from "./fakes/composed-installation.js";
import { GUILD_ID } from "./fakes/normalize.js";
import { DiscordRestOperation } from "../../../src/features/discord/models/domain/discord-rest-operation.enum.js";
import { restOk } from "./fakes/fake-discord-rest-transport.js";
import { restHarness } from "./fakes/rest-harness.js";

/**
 * R10 — this feature owns no business state, proved structurally rather than promised. The spec's proof
 * for R10 is a structural test: no repository, no migration, no feature-owned table, and a restart that
 * resets status and counters and persists nothing.
 *
 * Two directions are checked. What the feature must not contain: persistence imports, SQL, entity or
 * repository files, controllers, filesystem or environment access. What must be true of the state it does
 * hold: it lives in the process, and a second Installation of the same configuration starts empty — no
 * delivery is replayed, no counter carries over, no gap survives.
 */

/** Anchored on this file's own location, so the scan does not depend on the runner's working directory. */
const FEATURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "features", "discord");

function featureSources(dir: string = FEATURE_ROOT): string[] {
	const found: string[] = [];

	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			found.push(...featureSources(path));
		} else if (path.endsWith(".ts")) {
			found.push(path);
		}
	}

	return found;
}

function relativePath(path: string): string {
	return relative(FEATURE_ROOT, path).replace(/\\/g, "/");
}

function contentsOf(path: string): string {
	return readFileSync(path, "utf8");
}

function filesMatching(pattern: RegExp): string[] {
	return featureSources()
		.filter((path) => pattern.test(contentsOf(path)))
		.map(relativePath);
}

function kindsMatching(pattern: RegExp): string[] {
	return featureSources()
		.filter((path) => pattern.test(bareCodeOf(contentsOf(path))))
		.map(relativePath);
}

/** Comments describe the rules this scan enforces; they are not uses of the things they name. */
function bareCodeOf(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\/\*|\*|\/\*\*)/.test(line))
		.join("\n");
}

function statusOf(installation: ReturnType<typeof composeInstallation>) {
	return new DiscordStatusGateway({
		connection: installation.connection,
		counters: installation.counters,
		delivery: installation.stream,
		gaps: installation.gaps,
		clock: installation.clock,
		logger: installation.logger
	}).read();
}

describe("R10 structural proof — no persistence, no state of its own", () => {
	it("the feature has no repositories, entities, migrations or controllers, by path", () => {
		for (const forbidden of ["repositories", "entities", "migrations", "controllers", "database", "persistence"]) {
			expect(existsSync(join(FEATURE_ROOT, forbidden)), `${forbidden}/ exists inside the feature`).toBe(false);
		}

		expect(featureSources().filter((path) => /\.(entity|repository|migration|controller)\.ts$/.test(path))).toEqual(
			[]
		);
	});

	it("the scan is looking at the real tree", () => {
		expect(featureSources().length).toBeGreaterThan(20);
		expect(featureSources().map(relativePath)).toContain("gateways/discord-rest.transport.gateway.ts");
	});

	it("nothing in the feature imports a database, an ORM or a table", () => {
		expect(
			filesMatching(/from "(?:node:)?(?:pg|typeorm|kysely|prisma|drizzle-orm|better-sqlite3)|@nestjs\/typeorm/)
		).toEqual([]);
		expect(
			filesMatching(/\bCREATE TABLE\b|\bINSERT INTO\b|\bUPDATE \w+ SET\b|\bDELETE FROM\b|\bSELECT .+ FROM\b/)
		).toEqual([]);
	});

	it("nothing in the feature touches the filesystem, the process or the environment", () => {
		// Reads of the environment belong to `shared/config`; here the values arrive as data (R9, R10).
		expect(kindsMatching(/from "node:(?:fs|path|os|child_process|net|worker_threads|dns|http|https)"/)).toEqual([]);
		expect(
			kindsMatching(
				/process\.env|globalThis\.|localStorage|indexedDB|readFileSync|writeFileSync|mkdirSync|createWriteStream/
			)
		).toEqual([]);
	});

	it("every piece of state the feature holds is an in-process accumulator", () => {
		const stateful = filesMatching(/class \w+(Counters|Gaps)\b/);

		expect(stateful.sort()).toEqual([
			"models/domain/discord-declared-gaps.ts",
			"models/domain/discord-transport-counters.ts"
		]);
		expect(contentsOf(join(FEATURE_ROOT, "models/domain/discord-transport-counters.ts")).toLowerCase()).toContain(
			"in-process"
		);
	});

	it("the REST adapter writes nothing: it hands back results and never accepts a payload to store", async () => {
		const h = restHarness();
		const stored: unknown[] = [];
		h.transport.reply(
			`/guilds/${GUILD_ID}/roles`,
			restOk([{ id: "6", name: "Staff", permissions: "8", position: 1 }])
		);

		const roles = await h.gateway.readRoles();
		stored.push(roles);

		expect(stored).toHaveLength(1);
		expect(h.transport.operations()).toEqual([DiscordRestOperation.roles]);
	});
});

describe("R10 behavioural proof — a restart persists nothing", () => {
	it("a second Installation of the same configuration starts with empty status and counters", async () => {
		const first = composeInstallation();
		first.stream.subscribe(DiscordEventKind.messageCreated, () => undefined);
		await first.connection.start();
		await first.stream.settle();
		first.emitRaw("MESSAGE_CREATE", messageFixture({ id: "801" }));
		await first.stream.settle();

		const beforeRestart = statusOf(first);
		expect(beforeRestart.counters.receivedRawEvents).toBe(1);
		// Two deliveries in the first process: the `resync-needed` signal of the connect, then the message.
		expect(beforeRestart.delivery.delivered).toBe(2);

		// "Restart": the process goes away and a new Installation is composed from the same configuration.
		await first.shutdown.shutdown();
		const second = composeInstallation();
		const deliveredAfterRestart: string[] = [];
		second.stream.subscribe(DiscordEventKind.messageCreated, (event) => {
			deliveredAfterRestart.push(event.kind);
		});

		const fresh = statusOf(second);
		expect(fresh.connection.status).toBe(DiscordConnectionStatus.disconnected);
		expect(fresh.connection.epoch).toBe(0);
		expect(Object.prototype.hasOwnProperty.call(fresh.connection, "lastConnectedInstant")).toBe(false);
		expect(fresh.counters.receivedRawEvents).toBe(0);
		expect(fresh.counters.resyncSignalsPublished).toBe(0);
		expect(fresh.delivery.pending).toBe(0);
		expect(fresh.delivery.delivered).toBe(0);
		expect(fresh.delivery.lastDeliveredInstant).toBeUndefined();
		expect(fresh.pendingGaps).toEqual([]);

		await second.connection.start();
		await second.stream.settle();

		// Nothing from the previous process was replayed: only this run's own signal exists.
		expect(deliveredAfterRestart).toEqual([]);
		expect(second.published().map((event) => event.kind)).toEqual([DiscordEventKind.resyncNeeded]);
		expect(statusOf(second).counters.receivedRawEvents).toBe(0);
	});
});
