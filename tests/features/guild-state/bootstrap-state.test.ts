import { describe, expect, it } from "vitest";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import type {
	GuildBootstrapPart,
	GuildBootstrapStateTracker
} from "../../../src/features/guild-state/models/domain/bootstrap-state.js";
import {
	GUILD_BOOTSTRAP_PARTS,
	bootstrapStateIsComplete,
	initialBootstrapState,
	isGuildAccessLostReason,
	withPartApplied
} from "../../../src/features/guild-state/models/domain/bootstrap-state.js";

/**
 * R2's completion bookkeeping on its own, apart from any read or any write. The rule is short — "bootstrap
 * completion is never claimed while any part is pending" — and it is the rule every caller of this feature
 * will trust, so it is stated once, over a frozen part list, and tested here against the whole list rather
 * than against whichever parts a particular pass happened to touch.
 *
 * In memory per process is the recorded decision (odd/tasks/guild-state.md T2): the tracker is not a table,
 * a restart is a new instance, and re-running the pass is safe because the registry's writes are idempotent
 * under Discord's own ids (R9). `GuildBootstrapStateTracker` is the contract a durable implementation (T8's
 * status semantics) replaces behind the same token, with no repository involved.
 */

const GUILD_ID = "160000000000000001";

describe("bootstrap state parts (R2)", () => {
	it("names every part the rule requires, in the order a pass applies them", () => {
		expect(GUILD_BOOTSTRAP_PARTS).toEqual(["guild", "roles", "channels", "roster", "thread-members"]);
		expect(Object.isFrozen(GUILD_BOOTSTRAP_PARTS)).toBe(true);
	});

	it("starts with every part pending and nothing complete", () => {
		const state = initialBootstrapState(GUILD_ID);
		expect(state.guildId).toBe(GUILD_ID);
		expect(bootstrapStateIsComplete(state)).toBe(false);
		for (const part of GUILD_BOOTSTRAP_PARTS) {
			expect(state.parts[part]).toBe("pending");
		}
	});

	it("is complete only when every part is applied, and no part at all before that", () => {
		let state = initialBootstrapState(GUILD_ID);
		for (const part of GUILD_BOOTSTRAP_PARTS) {
			state = withPartApplied(state, part);
			// The last one is the only moment the answer may change.
			expect(bootstrapStateIsComplete(state)).toBe(part === "thread-members");
		}
	});

	it("leaves the state it was given untouched, so a snapshot cannot be revised after the fact", () => {
		const before = initialBootstrapState(GUILD_ID);
		const after = withPartApplied(before, "guild");
		expect(before.parts.guild).toBe("pending");
		expect(after.parts.guild).toBe("applied");
		expect(Object.isFrozen(after.parts)).toBe(true);
	});
});

describe("in-memory bootstrap tracker (R2, R9)", () => {
	function tracker(): GuildBootstrapStateTracker {
		return new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
	}

	it("answers pending parts in pass order and never lists an applied one", () => {
		const state = tracker();
		expect(state.pendingParts()).toEqual([...GUILD_BOOTSTRAP_PARTS]);

		state.markApplied("roles");
		state.markApplied("guild");

		expect(state.pendingParts()).toEqual(["channels", "roster", "thread-members"]);
		expect(state.isApplied("roles")).toBe(true);
		expect(state.isApplied("roster")).toBe(false);
		expect(state.isComplete()).toBe(false);
	});

	it("treats recording an applied part twice as the same fact, so a retried pass cannot corrupt the state", () => {
		const state = tracker();
		state.markApplied("channels");
		state.markApplied("channels");
		expect(state.snapshot().parts.channels).toBe("applied");
		expect(state.pendingParts()).toEqual(["guild", "roles", "roster", "thread-members"]);
	});

	it("is not complete while one part is pending, even with four applied (R2's never-claim rule)", () => {
		const state = tracker();
		const appliedParts: readonly GuildBootstrapPart[] = ["guild", "roles", "channels", "roster"];
		for (const part of appliedParts) {
			state.markApplied(part);
		}
		expect(state.isComplete()).toBe(false);
		expect(state.pendingParts()).toEqual(["thread-members"]);

		state.markApplied("thread-members");
		expect(state.isComplete()).toBe(true);
	});

	it("carries the configured guild it tracks for, which is the only guild it can be about (R1)", () => {
		expect(tracker().guildId).toBe(GUILD_ID);
		expect(tracker().snapshot().guildId).toBe(GUILD_ID);
	});

	it("forgets everything on reset, which is how a resync re-runs this path (R11)", () => {
		const state = tracker();
		for (const part of GUILD_BOOTSTRAP_PARTS) {
			state.markApplied(part);
		}
		expect(state.isComplete()).toBe(true);

		state.reset();

		expect(state.isComplete()).toBe(false);
		expect(state.pendingParts()).toEqual([...GUILD_BOOTSTRAP_PARTS]);
	});

	it("shares no state between instances, so a process restart is a fresh tracker by construction", () => {
		const previous = tracker();
		for (const part of GUILD_BOOTSTRAP_PARTS) {
			previous.markApplied(part);
		}

		const restarted = tracker();

		expect(previous.isComplete()).toBe(true);
		expect(restarted.isComplete()).toBe(false);
		expect(restarted.snapshot().parts).toEqual(initialBootstrapState(GUILD_ID).parts);
	});
});

describe("read-failure classification for the bootstrap (R2, R7)", () => {
	it("names a 4xx as a lost guild, which is the failure that must stop the pass", () => {
		for (const reason of ["unauthorized", "not-found", "client-error"] as const) {
			expect(isGuildAccessLostReason(reason)).toBe(true);
		}
	});

	it("names every transient and technical reason as not-a-lost-guild, so it stays a pending part", () => {
		for (const reason of ["rate-limit", "server-error", "timeout", "transport", "validation"] as const) {
			expect(isGuildAccessLostReason(reason)).toBe(false);
		}
	});
});
