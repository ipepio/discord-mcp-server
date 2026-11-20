import { describe, expect, it } from "vitest";
import {
	completeChannelDescription,
	partitionOverwriteTargets,
	requireThreadMembershipChange,
	resolvedParentChannelId
} from "../../../src/features/guild-state/models/domain/event-application-rules.js";
import type { ChannelEventDescription } from "../../../src/features/guild-state/models/domain/event-application-rules.js";
import {
	InvalidPermissionBitfieldError,
	InvalidRegistryFieldValueError
} from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import type { RegistryChannel } from "../../../src/features/guild-state/models/domain/registry-records.js";

/**
 * The channel/thread, overwrite-target and thread-membership rules of `event-application-rules.ts`, proven at
 * the seam where they are stated (docs/features/guild-state.md R6, R7, R8, R10).
 *
 * The command suites prove these rules through their use cases; these cases prove the decisions themselves,
 * because the point of stating the rules once is that the *rule* is the testable thing — which parent id a
 * payload resolves to, which overwrite target may be stored, which change direction exists at all. A later
 * task (T7's evaluation, T8's resync) reads the same functions, so a drift here is a drift everywhere.
 */

const GUILD_ID = "160000000000000001";
const CHANNEL_PRIVATE = "160000000000000201";
const THREAD_PRIVATE = "160000000000000203";
const CATEGORY = "160000000000000204";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const VIEW_CHANNEL = "1024";
const UNSAFE_BITFIELD = "9007199254740993";

function storedChannel(overrides: Partial<RegistryChannel> = {}): RegistryChannel {
	return {
		guildId: GUILD_ID,
		channelId: CHANNEL_PRIVATE,
		channelType: "guild-text",
		name: "stored-name",
		position: 4,
		parentChannelId: null,
		...overrides
	};
}

function description(overrides: Partial<ChannelEventDescription> = {}): ChannelEventDescription {
	return {
		channelId: CHANNEL_PRIVATE,
		channelType: "guild-text",
		name: "private",
		position: 0,
		...overrides
	};
}

describe("resolvedParentChannelId (R6, R10)", () => {
	it("takes the parent the payload carried, absent the payload's silence", () => {
		expect(resolvedParentChannelId(description({ parentChannelId: CATEGORY }), null)).toBe(CATEGORY);
	});

	it("completes a parent the payload omitted from the stored row", () => {
		expect(resolvedParentChannelId(description(), storedChannel({ parentChannelId: CATEGORY }))).toBe(CATEGORY);
	});

	it("keeps an explicit null as the statement that the row has no parent", () => {
		// `null` is what a caller says when the payload said so; an omitted field is the payload saying nothing.
		expect(
			resolvedParentChannelId(
				description({ parentChannelId: null }),
				storedChannel({ parentChannelId: CATEGORY })
			)
		).toBe(null);
	});

	it("resolves to nothing for a fresh row whose payload named no parent", () => {
		expect(resolvedParentChannelId(description(), null)).toBeNull();
	});
});

describe("completeChannelDescription (R6, R10)", () => {
	it("builds the whole row from a complete payload and reports nothing as completed", () => {
		const outcome = completeChannelDescription(
			GUILD_ID,
			description({ parentChannelId: CATEGORY }),
			null,
			CATEGORY,
			true
		);

		expect(outcome).toEqual({
			status: "complete",
			channel: {
				guildId: GUILD_ID,
				channelId: CHANNEL_PRIVATE,
				channelType: "guild-text",
				name: "private",
				position: 0,
				parentChannelId: CATEGORY
			},
			completedFields: []
		});
	});

	it("names each field it completed from the stored row and never blanks it (R10)", () => {
		const outcome = completeChannelDescription(
			GUILD_ID,
			{ channelId: CHANNEL_PRIVATE, channelType: "guild-text" },
			storedChannel(),
			null,
			false
		);

		expect(outcome).toMatchObject({ status: "complete", completedFields: ["name", "position", "parentChannelId"] });
		if (outcome.status !== "complete") {
			throw new Error("unreachable in this case");
		}
		expect(outcome.channel.name).toBe("stored-name");
		expect(outcome.channel.position).toBe(4);
	});

	it("leaves a field with no source at all null instead of inventing one (R10)", () => {
		// A thread event carries no position and the row has never been seen: `null` is the honest fact, and a
		// REST snapshot replaces it wholesale later (R2, R11). Zero would be an invention.
		const outcome = completeChannelDescription(
			GUILD_ID,
			{ channelId: THREAD_PRIVATE, channelType: "private-thread", parentChannelId: CHANNEL_PRIVATE },
			null,
			CHANNEL_PRIVATE,
			true
		);

		expect(outcome).toMatchObject({ status: "complete", channel: { position: null, name: null } });
	});

	it("refuses a thread that resolves to no parent (R6's error case)", () => {
		expect(
			completeChannelDescription(GUILD_ID, description({ channelType: "public-thread" }), null, null, false)
		).toEqual({ status: "refused", reason: "thread-parent-missing", parentChannelId: null });
	});

	it("refuses a row whose named parent is not registered, thread or not (R6's resolvable parent)", () => {
		expect(
			completeChannelDescription(GUILD_ID, description({ parentChannelId: CATEGORY }), null, CATEGORY, false)
		).toEqual({ status: "refused", reason: "parent-not-registered", parentChannelId: CATEGORY });
		expect(
			completeChannelDescription(
				GUILD_ID,
				{ channelId: THREAD_PRIVATE, channelType: "private-thread", parentChannelId: CATEGORY },
				null,
				CATEGORY,
				false
			)
		).toEqual({ status: "refused", reason: "parent-not-registered", parentChannelId: CATEGORY });
	});

	it("accepts a top-level channel that has no parent at all", () => {
		expect(
			completeChannelDescription(GUILD_ID, description({ parentChannelId: null }), null, null, false)
		).toMatchObject({
			status: "complete",
			channel: { parentChannelId: null }
		});
	});
});

describe("partitionOverwriteTargets (R7)", () => {
	it("keeps role and member targets exactly as reported, bitfields included", () => {
		const partition = partitionOverwriteTargets([
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
			{ targetId: USER_ONE, targetType: "member", allowBitfield: "0", denyBitfield: UNSAFE_BITFIELD }
		]);

		expect(partition.storable).toEqual([
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
			{ targetId: USER_ONE, targetType: "member", allowBitfield: "0", denyBitfield: UNSAFE_BITFIELD }
		]);
		expect(partition.droppedTargetIds).toEqual([]);
	});

	it("drops a target whose kind is neither role nor member and names it in the count", () => {
		const partition = partitionOverwriteTargets([
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: "0", denyBitfield: "0" },
			{
				targetId: USER_ONE,
				targetType: "webhook",
				allowBitfield: "0",
				denyBitfield: "0"
			} as unknown as (typeof partition.storable)[number]
		]);

		expect(partition.storable).toHaveLength(1);
		expect(partition.droppedTargetIds).toEqual([USER_ONE]);
	});

	it("refuses a bitfield that is not Discord's own decimal text (R3, R7)", () => {
		expect(() =>
			partitionOverwriteTargets([
				{
					targetId: ROLE_BACKEND,
					targetType: "role",
					allowBitfield: 1024 as unknown as string,
					denyBitfield: "0"
				}
			])
		).toThrow(InvalidPermissionBitfieldError);
	});
});

describe("requireThreadMembershipChange (R8)", () => {
	it("accepts the two directions the rule names", () => {
		expect(requireThreadMembershipChange("thread_membership.change", "added")).toBe("added");
		expect(requireThreadMembershipChange("thread_membership.change", "removed")).toBe("removed");
	});

	it("refuses anything else instead of guessing the direction of an edge", () => {
		expect(() => requireThreadMembershipChange("thread_membership.change", "unchanged")).toThrow(
			InvalidRegistryFieldValueError
		);
		expect(() => requireThreadMembershipChange("thread_membership.change", undefined)).toThrow(
			/thread_membership\.change/
		);
	});
});
