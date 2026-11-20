import { describe, expect, it } from "vitest";
import { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import type {
	GuildUpdatedEvent,
	MemberAddedEvent,
	MemberRemovedEvent,
	MemberUpdatedEvent,
	RoleCreatedEvent,
	RoleDeletedEvent,
	RoleUpdatedEvent,
	ThreadMemberAddedEvent,
	ThreadMemberRemovedEvent
} from "../../../../src/features/discord/models/domain/normalized-discord-event.js";
import { expectRejected, GUILD_ID, normalizeMany, normalizeOne } from "../fakes/normalize.js";

/**
 * R3 — Guild, role, membership and thread-membership normalization, field by field. The role set of a
 * member is the whole set at that instant, because consumers replace state rather than merge it
 * (guild-state R5, R9), and an absent optional fact stays absent.
 */

describe("R3 — guild-updated", () => {
	it("maps the Guild snapshot fields of a GUILD_UPDATE payload", () => {
		expect(
			normalizeOne("GUILD_UPDATE", {
				id: GUILD_ID,
				name: "Example Guild",
				owner_id: "300",
				approximate_member_count: 42
			})
		).toEqual<GuildUpdatedEvent>({
			kind: DiscordEventKind.guildUpdated,
			guildId: GUILD_ID,
			guildName: "Example Guild",
			ownerId: "300",
			memberCount: 42
		});
	});

	it("maps a GUILD_CREATE payload to the same kind, because the kind names the resource", () => {
		const event = normalizeOne<GuildUpdatedEvent>("GUILD_CREATE", { id: GUILD_ID, name: "Example Guild" });

		expect(event.kind).toBe(DiscordEventKind.guildUpdated);
		expect(event.guildName).toBe("Example Guild");
		expect(Object.hasOwn(event, "ownerId")).toBe(false);
		expect(Object.hasOwn(event, "memberCount")).toBe(false);
	});

	it("does not derive roles, channels or members from the snapshot: the transport invents no state", () => {
		const event = normalizeOne("GUILD_CREATE", {
			id: GUILD_ID,
			name: "Example Guild",
			roles: [{ id: "200", name: "@everyone" }],
			channels: [{ id: "400", name: "backend" }]
		});

		expect(Object.keys(event).sort()).toEqual(["guildId", "guildName", "kind"]);
	});

	it("rejects an optional Guild field that is malformed, without re-checking the filtered Guild id", () => {
		// The source filter already proved the Guild id (R2); the mapper validates the rest.
		expectRejected("GUILD_UPDATE", { id: GUILD_ID, name: "Example Guild", owner_id: "nope" }, "owner_id");
	});
});

describe("R3 — role kinds", () => {
	it("maps a created role with its name and permission bitfield", () => {
		expect(
			normalizeOne("GUILD_ROLE_CREATE", {
				guild_id: GUILD_ID,
				role: { id: "200", name: "staff", permissions: "1043206977", color: 16_711_935, position: 4 }
			})
		).toEqual<RoleCreatedEvent>({
			kind: DiscordEventKind.roleCreated,
			guildId: GUILD_ID,
			roleId: "200",
			roleName: "staff",
			permissionsBitfield: "1043206977"
		});
	});

	it("keeps an absent permission bitfield absent rather than empty", () => {
		const event = normalizeOne("GUILD_ROLE_UPDATE", { guild_id: GUILD_ID, role: { id: "200" } });

		expect(event).toEqual<RoleUpdatedEvent>({
			kind: DiscordEventKind.roleUpdated,
			guildId: GUILD_ID,
			roleId: "200"
		});
	});

	it("maps a deleted role by id", () => {
		expect(normalizeOne("GUILD_ROLE_DELETE", { guild_id: GUILD_ID, role_id: "200" })).toEqual<RoleDeletedEvent>({
			kind: DiscordEventKind.roleDeleted,
			guildId: GUILD_ID,
			roleId: "200"
		});
	});

	it("rejects a role payload without the nested role object", () => {
		expectRejected("GUILD_ROLE_CREATE", { guild_id: GUILD_ID }, "role");
	});

	it("rejects a role deletion without a role id", () => {
		expectRejected("GUILD_ROLE_DELETE", { guild_id: GUILD_ID }, "role_id");
	});
});

describe("R3 — member kinds", () => {
	it("maps a joined member with the whole role set", () => {
		expect(
			normalizeOne("GUILD_MEMBER_ADD", {
				guild_id: GUILD_ID,
				user: { id: "300", username: "someone", bot: false },
				roles: ["200", "201"],
				joined_at: "2026-11-05T09:00:00.000Z",
				nick: "som",
				pending: false
			})
		).toEqual<MemberAddedEvent>({
			kind: DiscordEventKind.memberAdded,
			guildId: GUILD_ID,
			userId: "300",
			roleIds: ["200", "201"],
			nickname: "som",
			joinedInstant: new Date("2026-11-05T09:00:00.000Z"),
			isPending: false
		});
	});

	it("keeps a member without roles as an explicit empty set and a null nickname as absent", () => {
		const event = normalizeOne<MemberAddedEvent>("GUILD_MEMBER_ADD", {
			guild_id: GUILD_ID,
			user: { id: "300" },
			roles: [],
			nick: null,
			joined_at: "2026-11-05T09:00:00.000Z"
		});

		expect(event.roleIds).toEqual([]);
		expect(Object.hasOwn(event, "nickname")).toBe(false);
		expect(Object.hasOwn(event, "isPending")).toBe(false);
	});

	it("maps the after-state of a member update, which is the state consumers store", () => {
		expect(
			normalizeOne("GUILD_MEMBER_UPDATE", {
				guild_id: GUILD_ID,
				before: { roles: ["200"], nick: "old" },
				after: {
					roles: ["200", "202"],
					nick: "new",
					user: { id: "300" },
					joined_at: "2026-11-05T09:00:00.000Z"
				}
			})
		).toEqual<MemberUpdatedEvent>({
			kind: DiscordEventKind.memberUpdated,
			guildId: GUILD_ID,
			userId: "300",
			roleIds: ["200", "202"],
			nickname: "new",
			joinedInstant: new Date("2026-11-05T09:00:00.000Z")
		});
	});

	it("maps a departure by user id only", () => {
		expect(
			normalizeOne("GUILD_MEMBER_REMOVE", { guild_id: GUILD_ID, user: { id: "300" } })
		).toEqual<MemberRemovedEvent>({
			kind: DiscordEventKind.memberRemoved,
			guildId: GUILD_ID,
			userId: "300"
		});
	});

	it("rejects a member payload without a user", () => {
		expectRejected("GUILD_MEMBER_ADD", { guild_id: GUILD_ID, roles: [] }, "user");
	});

	it("rejects a member update whose after-state carries no user id", () => {
		expectRejected("GUILD_MEMBER_UPDATE", { guild_id: GUILD_ID, after: { roles: [] } }, "after.user");
	});

	it("rejects a role set that is not a list of snowflakes", () => {
		expectRejected("GUILD_MEMBER_ADD", { guild_id: GUILD_ID, user: { id: "300" }, roles: ["200", 201] }, "roles");
	});
});

describe("R3 — thread membership kinds", () => {
	it("maps one added member", () => {
		expect(
			normalizeMany("THREAD_MEMBERS_UPDATE", {
				id: "410",
				guild_id: GUILD_ID,
				member_count: 2,
				added_members: [{ id: "300" }]
			})
		).toEqual<ThreadMemberAddedEvent[]>([
			{ kind: DiscordEventKind.threadMemberAdded, guildId: GUILD_ID, threadId: "410", userId: "300" }
		]);
	});

	it("prefers the explicit user id of an added member", () => {
		const events = normalizeMany("THREAD_MEMBERS_UPDATE", {
			id: "410",
			guild_id: GUILD_ID,
			added_members: [{ id: "999", user_id: "300" }]
		});

		expect((events[0] as ThreadMemberAddedEvent).userId).toBe("300");
	});

	it("maps added and removed members of one raw event as separate events, additions first", () => {
		expect(
			normalizeMany("THREAD_MEMBERS_UPDATE", {
				id: "410",
				guild_id: GUILD_ID,
				added_members: [{ id: "300" }, { id: "301" }],
				removed_member_ids: ["302"]
			})
		).toEqual<(ThreadMemberAddedEvent | ThreadMemberRemovedEvent)[]>([
			{ kind: DiscordEventKind.threadMemberAdded, guildId: GUILD_ID, threadId: "410", userId: "300" },
			{ kind: DiscordEventKind.threadMemberAdded, guildId: GUILD_ID, threadId: "410", userId: "301" },
			{ kind: DiscordEventKind.threadMemberRemoved, guildId: GUILD_ID, threadId: "410", userId: "302" }
		]);
	});

	it("publishes nothing for a membership event carrying only a count", () => {
		expect(normalizeMany("THREAD_MEMBERS_UPDATE", { id: "410", guild_id: GUILD_ID, member_count: 3 })).toEqual([]);
	});

	it("rejects a membership delta whose thread id is missing", () => {
		expectRejected("THREAD_MEMBERS_UPDATE", { guild_id: GUILD_ID, added_members: [] }, "id");
	});

	it("rejects a malformed removed member id and reports the index", () => {
		expectRejected(
			"THREAD_MEMBERS_UPDATE",
			{ id: "410", guild_id: GUILD_ID, removed_member_ids: ["302", "bad"] },
			"removed_member_ids[1]"
		);
	});
});
