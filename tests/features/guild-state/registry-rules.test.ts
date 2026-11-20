import { describe, expect, it } from "vitest";
import type { NormalizedChannelType } from "../../../src/features/discord/index.js";
import type { RegistryChannel } from "../../../src/features/guild-state/models/domain/registry-records.js";
import {
	everyoneRoleIdFor,
	isForeignGuildRecord,
	isThreadChannelType,
	registryChannelIsThread,
	requireThreadParent
} from "../../../src/features/guild-state/models/domain/registry-rules.js";
import { ThreadParentRequiredError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";

/**
 * R1 and R6 — the two registry rules the feature states in code before any SQL runs, so a row that breaks
 * them is refused by guild-state rather than surfacing as a constraint error a caller would have to read.
 * R6's case is the one worth pinning: thread-ness is *derived* from the normalized channel type, so a write
 * path cannot mark a thread as an ordinary channel to dodge the parent requirement.
 */

const GUILD_ID = "160000000000000001";
const CHANNEL_ID = "160000000000000002";
const PARENT_ID = "160000000000000003";

function channel(overrides: Partial<RegistryChannel> = {}): RegistryChannel {
	return {
		guildId: GUILD_ID,
		channelId: CHANNEL_ID,
		channelType: "guild-text",
		name: "general",
		position: 0,
		parentChannelId: null,
		...overrides
	};
}

describe("thread-ness — derived, never declared (R6)", () => {
	it("recognizes exactly the three thread types Discord's normalized vocabulary names", () => {
		const threadTypes: NormalizedChannelType[] = ["announcement-thread", "public-thread", "private-thread"];
		for (const channelType of threadTypes) {
			expect(isThreadChannelType(channelType), channelType).toBe(true);
			expect(registryChannelIsThread(channel({ channelType })), channelType).toBe(true);
		}
	});

	it("treats every non-thread type as a channel, including the containers threads live in", () => {
		const channelTypes: NormalizedChannelType[] = [
			"guild-text",
			"dm",
			"guild-voice",
			"group-dm",
			"guild-category",
			"guild-announcement",
			"guild-stage-voice",
			"guild-directory",
			"guild-forum",
			"guild-media",
			// A type the vocabulary does not name is stored as a channel and never smuggled in parentless on a
			// guess: the registry's own comment states the rule, and the CHECK in the schema repeats it.
			"unknown"
		];
		for (const channelType of channelTypes) {
			expect(isThreadChannelType(channelType), channelType).toBe(false);
			expect(registryChannelIsThread(channel({ channelType })), channelType).toBe(false);
		}
	});

	it("does not let a caller claim a thread is a channel: the type decides, not a flag (R6)", () => {
		// The record carries no `isThread` field at all, so there is nothing for a caller to lie with.
		expect("isThread" in channel()).toBe(false);
		expect(registryChannelIsThread(channel({ channelType: "private-thread", parentChannelId: null }))).toBe(true);
	});
});

describe("thread parent requirement (R6)", () => {
	it("accepts a thread that carries a parent", () => {
		expect(() =>
			requireThreadParent(channel({ channelType: "private-thread", parentChannelId: PARENT_ID }))
		).not.toThrow();
	});

	it("accepts a parentless non-thread: a top-level channel is a legal row", () => {
		expect(() => requireThreadParent(channel({ channelType: "guild-text", parentChannelId: null }))).not.toThrow();
	});

	it("rejects a thread without a parent, naming the ids and the type (R6 error case, R14 log shape)", () => {
		let caught: unknown;
		try {
			requireThreadParent(channel({ channelType: "announcement-thread", parentChannelId: null }));
		} catch (failure) {
			caught = failure;
		}
		expect(caught).toBeInstanceOf(ThreadParentRequiredError);
		const error = caught as ThreadParentRequiredError;
		expect(error.guildId).toBe(GUILD_ID);
		expect(error.channelId).toBe(CHANNEL_ID);
		expect(error.channelType).toBe("announcement-thread");
		expect(error.message).toContain(CHANNEL_ID);
		expect(error.name).toBe("ThreadParentRequiredError");
	});

	it("accepts a non-thread that names a parent, which is a category, not a thread (R6/R7)", () => {
		// A text channel under a category carries a parent and is still not a thread: the rule is one-way.
		expect(() =>
			requireThreadParent(channel({ channelType: "guild-text", parentChannelId: PARENT_ID }))
		).not.toThrow();
	});
});

describe("@everyone folding and guild isolation (R3 boundary, R1)", () => {
	it("derives the @everyone role id from the guild id, which is why it is never in a member's role set", () => {
		expect(everyoneRoleIdFor(GUILD_ID)).toBe(GUILD_ID);
	});

	it("flags a record from any other guild as foreign, comparing the id alone", () => {
		expect(isForeignGuildRecord(GUILD_ID, GUILD_ID)).toBe(false);
		expect(isForeignGuildRecord("160000000000000099", GUILD_ID)).toBe(true);
	});
});
