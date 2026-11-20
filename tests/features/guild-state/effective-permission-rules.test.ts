import { describe, expect, it } from "vitest";
import type { DiscordIdentifier } from "../../../src/features/guild-state/models/domain/discord-identifier.js";
import {
	ALL_DISCORD_PERMISSION_BITS,
	DISCORD_PERMISSION_NAMES,
	bitsIncludePermission
} from "../../../src/features/guild-state/models/domain/discord-permissions.js";
import type {
	EffectivePermissionEmptyReason,
	RegistryChannelDerivation
} from "../../../src/features/guild-state/models/domain/effective-permission-rules.js";
import {
	deriveEffectivePermissions,
	distinctRefusalReasons,
	scanEffectivePermissionsAcrossRegistry
} from "../../../src/features/guild-state/models/domain/effective-permission-rules.js";
import type {
	RegistryChannel,
	RegistryChannelOverwrite,
	RegistryMembership,
	RegistryPermissionSnapshot,
	RegistryRolePermission
} from "../../../src/features/guild-state/models/domain/registry-records.js";

/**
 * The derivation order the spec fixes (docs/features/guild-state.md Contracts; R3, R4, R5, R6, R7, R8, R13).
 * Every case below is one stage or one interaction between two stages, driven by faked projections — a
 * {@link RegistryPermissionSnapshot} built by hand — so what is proven is the arithmetic of the rule and
 * nothing else: no repository, no SQL, no Discord. The snapshot is deep-frozen, which makes R13's purity a
 * property the run enforces: a derivation that wrote back into its input would throw.
 *
 * Ids: the Guild id doubles as the `@everyone` role id, exactly as R3 states.
 */

const GUILD: DiscordIdentifier = "160000000000000001";
const EVERYONE = GUILD;
const USER: DiscordIdentifier = "160000000000000101";
const OTHER_USER: DiscordIdentifier = "160000000000000102";
const ROLE_BACKEND: DiscordIdentifier = "160000000000000010";
const ROLE_OPS: DiscordIdentifier = "160000000000000011";
const ROLE_UNKNOWN: DiscordIdentifier = "160000000000000012";
const CHANNEL: DiscordIdentifier = "160000000000000201";
const PARENT: DiscordIdentifier = "160000000000000202";
const THREAD: DiscordIdentifier = "160000000000000203";
const PRIVATE_THREAD: DiscordIdentifier = "160000000000000204";
const FOREIGN_CHANNEL: DiscordIdentifier = "160000000000000901";

const VIEW = 1024n;
const SEND = 2048n;
const HISTORY = 65536n;
const MENTION = 131072n;
const ADMINISTRATOR = 8n;
/** 2^50 and 2^51: the pair whose union a JavaScript number cannot hold exactly alongside the low bits. */
const EXTERNAL_APPS = 1125899906842624n;
const PIN = 2251799813685248n;

interface SnapshotFixture {
	readonly guildId?: DiscordIdentifier;
	readonly membership?: RegistryMembership | null;
	readonly everyone?: string | null;
	readonly roles?: readonly RegistryRolePermission[];
	readonly channels?: readonly RegistryChannel[];
	readonly overwrites?: readonly (readonly [DiscordIdentifier, readonly RegistryChannelOverwrite[]])[];
	readonly privateThreadIds?: readonly DiscordIdentifier[];
}

function channel(
	channelId: DiscordIdentifier,
	channelType: RegistryChannel["channelType"] = "guild-text",
	parentChannelId: DiscordIdentifier | null = null,
	guildId: DiscordIdentifier = GUILD
): RegistryChannel {
	return { guildId, channelId, channelType, name: null, position: null, parentChannelId };
}

function role(roleId: DiscordIdentifier, permissionsBitfield: string): RegistryRolePermission {
	return { roleId, permissionsBitfield };
}

function overwrite(
	targetId: DiscordIdentifier,
	targetType: RegistryChannelOverwrite["targetType"],
	allow: string | bigint = 0n,
	deny: string | bigint = 0n
): RegistryChannelOverwrite {
	return {
		targetId,
		targetType,
		allowBitfield: typeof allow === "bigint" ? allow.toString() : allow,
		denyBitfield: typeof deny === "bigint" ? deny.toString() : deny
	};
}

/** A deep-frozen snapshot: nothing can be mutated, so a leak from the derivation is a thrown TypeError. */
function snapshot(fixture: SnapshotFixture = {}): RegistryPermissionSnapshot {
	const channels = fixture.channels ?? [channel(CHANNEL)];
	const explicit = fixture.overwrites ?? [];
	const built = channels.map(
		(candidate) => [candidate.channelId, explicit.find(([id]) => id === candidate.channelId)?.[1] ?? []] as const
	);
	return freeze({
		guild: { guildId: fixture.guildId ?? GUILD, guildName: "Test guild" },
		membership:
			fixture.membership === undefined
				? { guildId: fixture.guildId ?? GUILD, userId: USER, roleIds: [] }
				: fixture.membership,
		everyonePermissions: fixture.everyone === undefined ? "0" : fixture.everyone,
		rolePermissions: fixture.roles ?? [],
		channels,
		overwriteSets: built.map(([channelId, overwrites]) => ({
			guildId: fixture.guildId ?? GUILD,
			channelId,
			overwrites
		})),
		privateThreadIds: fixture.privateThreadIds ?? []
	});
}

function freeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	for (const nested of Object.values(value)) {
		freeze(nested);
	}
	return Object.freeze(value);
}

function evaluate(fixture: SnapshotFixture, channelId: DiscordIdentifier = CHANNEL) {
	return deriveEffectivePermissions({ guildId: GUILD, userId: USER, channelId, snapshot: snapshot(fixture) });
}

describe("stage 1 — the base is @everyone unioned with the member's roles (R3, R5)", () => {
	it("folds @everyone for a member whose role set is empty", () => {
		// R3's boundary case: Discord never lists @everyone in a member's set, so the base comes from the
		// Guild-keyed role row and the empty set is a real state, not a missing Membership.
		const derived = evaluate({ everyone: String(VIEW | HISTORY) });
		expect(derived.permissions.bitfield).toBe(String(VIEW | HISTORY));
		expect(derived.permissions.has("view-channel")).toBe(true);
		expect(derived.permissions.has("read-message-history")).toBe(true);
		expect(derived.permissions.has("send-messages")).toBe(false);
	});

	it("unions @everyone with every role the member holds", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND, ROLE_OPS] },
			roles: [role(ROLE_BACKEND, String(HISTORY)), role(ROLE_OPS, String(SEND))]
		});
		expect(derived.permissions.bitfield).toBe(String(VIEW | HISTORY | SEND));
	});

	it("adds nothing for a role id the registry does not hold (R5's error case)", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND, ROLE_UNKNOWN] },
			roles: [role(ROLE_BACKEND, String(HISTORY))]
		});
		expect(derived.permissions.bitfield).toBe(String(VIEW | HISTORY));
		expect(derived.reason).toBeNull();
	});

	it("does not double-count @everyone when a stored set names it anyway", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			membership: { guildId: GUILD, userId: USER, roleIds: [EVERYONE, ROLE_BACKEND] },
			roles: [role(EVERYONE, String(VIEW | SEND)), role(ROLE_BACKEND, String(HISTORY))]
		});
		expect(derived.permissions.bitfield).toBe(String(VIEW | HISTORY));
	});

	it("keeps every bit above 2^53 exactly, in the union and in the rendered text (R3)", () => {
		const derived = evaluate({
			everyone: "0",
			membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND, ROLE_OPS] },
			roles: [role(ROLE_BACKEND, EXTERNAL_APPS.toString()), role(ROLE_OPS, PIN.toString())]
		});
		const expected = (EXTERNAL_APPS | PIN).toString();
		expect(derived.permissions.bitfield).toBe(expected);
		expect(BigInt(derived.permissions.bitfield) & 1n).toBe(0n);
		expect(derived.permissions.has("use-external-apps")).toBe(true);
		expect(derived.permissions.has("pin-messages")).toBe(true);
		// The defect R3 names would have rounded this pair to a lower value; the text proves it did not.
		expect(expected).toBe("3377699720527872");
	});
});

describe("stage 2 — the administrator bypass (Contracts: every permission, overwrite stages skipped)", () => {
	it("grants every named permission and skips every overwrite stage", () => {
		const derived = evaluate({
			everyone: String(ADMINISTRATOR),
			channels: [channel(CHANNEL)],
			overwrites: [
				[CHANNEL, [overwrite(EVERYONE, "role", 0n, VIEW | HISTORY), overwrite(USER, "member", 0n, VIEW)]]
			]
		});
		expect(derived.administratorBypass).toBe(true);
		expect(derived.overwriteLevels).toEqual([]);
		for (const name of DISCORD_PERMISSION_NAMES) {
			expect(derived.permissions.has(name), name).toBe(true);
		}
		expect(derived.permissions.bitfield).toBe(String(ALL_DISCORD_PERMISSION_BITS));
	});

	it("bypasses from a role bit, not only from the @everyone bit", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND] },
			roles: [role(ROLE_BACKEND, String(ADMINISTRATOR))],
			overwrites: [[CHANNEL, [overwrite(USER, "member", 0n, ADMINISTRATOR)]]]
		});
		expect(derived.administratorBypass).toBe(true);
		expect(derived.permissions.has("manage-roles")).toBe(true);
	});

	it("does not bypass when the bit appears only in an overwrite allow, which stage 2 never reads", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			overwrites: [[CHANNEL, [overwrite(EVERYONE, "role", ADMINISTRATOR)]]]
		});
		expect(derived.administratorBypass).toBe(false);
		// The overwrite still grants it — Discord's rule is about the base, and stage 3 is a plain allow.
		expect(derived.permissions.has("administrator")).toBe(true);
	});
});

describe("stage 3 — the @everyone overwrite: deny cleared, then allow applied", () => {
	it("removes a base grant @everyone denies", () => {
		const derived = evaluate({
			everyone: String(VIEW | HISTORY | SEND),
			overwrites: [[CHANNEL, [overwrite(EVERYONE, "role", 0n, SEND)]]]
		});
		expect(derived.permissions.bitfield).toBe(String(VIEW | HISTORY));
	});

	it("adds a grant the base never had", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			overwrites: [[CHANNEL, [overwrite(EVERYONE, "role", MENTION)]]]
		});
		expect(derived.permissions.has("mention-everyone")).toBe(true);
	});

	it("applies allow after deny inside the same row, so a bit in both is granted", () => {
		// The order the spec states: "remove its deny bits, then add its allow bits".
		const derived = evaluate({
			everyone: String(VIEW),
			overwrites: [[CHANNEL, [overwrite(EVERYONE, "role", VIEW, VIEW)]]]
		});
		expect(derived.permissions.has("view-channel")).toBe(true);
		expect(derived.overwriteLevels).toEqual([CHANNEL]);
	});

	it("ignores a member-targeted row at this stage", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			overwrites: [[CHANNEL, [overwrite(USER, "member", MENTION)]]]
		});
		expect(derived.permissions.has("mention-everyone")).toBe(true); // stage 5 still applies it
		const notMine = evaluate({
			everyone: String(VIEW),
			overwrites: [[CHANNEL, [overwrite(OTHER_USER, "member", 0n, VIEW)]]]
		});
		expect(notMine.permissions.has("view-channel")).toBe(true);
	});
});

describe("stage 4 — the union of the member's role overwrites (R7's boundary)", () => {
	const rolesFixture = (overwrites: readonly RegistryChannelOverwrite[]) => ({
		everyone: String(VIEW),
		membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND, ROLE_OPS] },
		roles: [role(ROLE_BACKEND, String(HISTORY)), role(ROLE_OPS, "0")],
		overwrites: [[CHANNEL, overwrites] as const]
	});

	it("lets allow beat deny inside the role stage", () => {
		// Allowed by one role, denied by another: the union clears both first, then applies the allows.
		const derived = evaluate(
			rolesFixture([overwrite(ROLE_OPS, "role", 0n, HISTORY), overwrite(ROLE_BACKEND, "role", HISTORY)])
		);
		expect(derived.permissions.has("read-message-history")).toBe(true);
	});

	it("denies what only one role granted when no role allows it", () => {
		const derived = evaluate(
			rolesFixture([overwrite(ROLE_BACKEND, "role", 0n, HISTORY), overwrite(ROLE_OPS, "role")])
		);
		expect(derived.permissions.has("read-message-history")).toBe(false);
	});

	it("never lets a role the member does not hold participate", () => {
		const outsider: DiscordIdentifier = "160000000000000099";
		const derived = evaluate(
			rolesFixture([overwrite(outsider, "role", 0n, VIEW), overwrite(outsider, "role", MENTION)])
		);
		expect(derived.permissions.has("view-channel")).toBe(true);
		expect(derived.permissions.has("mention-everyone")).toBe(false);
	});

	it("treats a role-targeted row for @everyone as stage 3's, not stage 4's", () => {
		// The Guild-keyed row is consumed by the earlier stage, so the ordering stays as Contracts states it.
		const derived = evaluate({
			everyone: String(VIEW),
			membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND] },
			roles: [role(ROLE_BACKEND, "0")],
			overwrites: [
				[CHANNEL, [overwrite(EVERYONE, "role", 0n, VIEW), overwrite(ROLE_BACKEND, "role", VIEW)]] as const
			]
		});
		expect(derived.permissions.has("view-channel")).toBe(true);
	});
});

describe("stage 5 — the member's own overwrite beats the role stage (R7's example)", () => {
	it("denies VIEW_CHANNEL the member's role allowed", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND] },
			roles: [role(ROLE_BACKEND, String(HISTORY))],
			overwrites: [
				[
					CHANNEL,
					[overwrite(ROLE_BACKEND, "role", HISTORY | VIEW), overwrite(USER, "member", 0n, VIEW | HISTORY)]
				]
			]
		});
		expect(derived.permissions.has("view-channel")).toBe(false);
		expect(derived.permissions.has("read-message-history")).toBe(false);
		expect(derived.permissions.bitfield).toBe("0");
	});

	it("applies the member row after the role row even when the rows arrive in the other order", () => {
		// R10: the stored set is a whole set, so the stage order — not the row order — decides.
		const reversed = evaluate({
			everyone: String(VIEW),
			membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND] },
			roles: [role(ROLE_BACKEND, String(VIEW))],
			overwrites: [[CHANNEL, [overwrite(USER, "member", 0n, VIEW), overwrite(ROLE_BACKEND, "role", VIEW)]]]
		});
		expect(reversed.permissions.has("view-channel")).toBe(false);
	});

	it("can restore a bit an earlier stage denied, because its allow is applied after its deny", () => {
		const derived = evaluate({
			everyone: String(VIEW | HISTORY),
			overwrites: [[CHANNEL, [overwrite(EVERYONE, "role", 0n, HISTORY), overwrite(USER, "member", HISTORY)]]]
		});
		expect(derived.permissions.has("read-message-history")).toBe(true);
	});

	it("ignores another member's row", () => {
		const derived = evaluate({
			everyone: String(VIEW),
			overwrites: [[CHANNEL, [overwrite(OTHER_USER, "member", 0n, VIEW)]]]
		});
		expect(derived.permissions.has("view-channel")).toBe(true);
	});
});

describe("a thread is evaluated over its parent's set (Contracts' thread rule)", () => {
	const threadChannel = [channel(THREAD, "public-thread", PARENT), channel(PARENT)];

	it("keeps the parent's deny when the thread carries no overwrites", () => {
		const derived = evaluate(
			{
				channels: threadChannel,
				everyone: String(VIEW | HISTORY),
				overwrites: [[PARENT, [overwrite(EVERYONE, "role", 0n, HISTORY)]]]
			},
			THREAD
		);
		expect(derived.overwriteLevels).toEqual([PARENT, THREAD]);
		expect(derived.permissions.has("view-channel")).toBe(true);
		expect(derived.permissions.has("read-message-history")).toBe(false);
	});

	it("lets the thread's own set re-grant what the parent denied", () => {
		const derived = evaluate(
			{
				channels: threadChannel,
				everyone: String(VIEW | HISTORY),
				overwrites: [
					[PARENT, [overwrite(EVERYONE, "role", 0n, HISTORY)]],
					[THREAD, [overwrite(EVERYONE, "role", HISTORY)]]
				]
			},
			THREAD
		);
		expect(derived.permissions.has("read-message-history")).toBe(true);
	});

	it("lets the thread's own set deny what the parent granted", () => {
		const derived = evaluate(
			{
				channels: threadChannel,
				everyone: String(VIEW | HISTORY),
				overwrites: [
					[PARENT, [overwrite(ROLE_BACKEND, "role", HISTORY)]],
					[THREAD, [overwrite(ROLE_BACKEND, "role", 0n, HISTORY)]]
				],
				membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND] },
				roles: [role(ROLE_BACKEND, "0")]
			},
			THREAD
		);
		expect(derived.permissions.has("read-message-history")).toBe(false);
	});

	it("applies both stages of both levels in order, so a parent member-row deny survives a thread role allow", () => {
		const derived = evaluate(
			{
				channels: threadChannel,
				everyone: String(VIEW | HISTORY),
				membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND] },
				roles: [role(ROLE_BACKEND, "0")],
				overwrites: [
					[PARENT, [overwrite(USER, "member", 0n, HISTORY)]],
					[THREAD, [overwrite(ROLE_BACKEND, "role", HISTORY)]]
				]
			},
			THREAD
		);
		expect(derived.permissions.has("read-message-history")).toBe(true);
	});
});

describe("private threads are admitted only by a stored membership edge (R8)", () => {
	const privateChannel = [channel(PRIVATE_THREAD, "private-thread", PARENT), channel(PARENT)];

	it("yields the empty set when the registry holds no edge for the user", () => {
		const derived = evaluate(
			{
				channels: privateChannel,
				everyone: String(VIEW | HISTORY),
				overwrites: [[THREAD, [overwrite(EVERYONE, "role", VIEW)]]]
			},
			PRIVATE_THREAD
		);
		expect(derived.status).toBe("empty");
		expect(derived.reason).toBe("private-thread-not-admitted");
		expect(derived.permissions.bitfield).toBe("0");
		expect(derived.permissions.granted).toEqual([]);
	});

	it("evaluates normally once the edge exists", () => {
		const derived = evaluate(
			{
				channels: privateChannel,
				everyone: String(VIEW | HISTORY),
				privateThreadIds: [PRIVATE_THREAD],
				overwrites: [[PRIVATE_THREAD, [overwrite(EVERYONE, "role", 0n, HISTORY)]]]
			},
			PRIVATE_THREAD
		);
		expect(derived.status).toBe("evaluated");
		expect(derived.permissions.has("view-channel")).toBe(true);
		expect(derived.permissions.has("read-message-history")).toBe(false);
	});

	it("keeps the bypass above the gate, as stage 2 is worded", () => {
		const derived = evaluate({ channels: privateChannel, everyone: String(ADMINISTRATOR) }, PRIVATE_THREAD);
		expect(derived.administratorBypass).toBe(true);
		expect(derived.status).toBe("evaluated");
	});

	it("does not gate a public thread", () => {
		const derived = evaluate({ channels: [channel(THREAD, "public-thread", PARENT), channel(PARENT)] }, THREAD);
		expect(derived.status).toBe("evaluated");
	});
});

describe("fail closed (R1, R4, R6)", () => {
	const refusals: readonly (readonly [string, SnapshotFixture, DiscordIdentifier, EffectivePermissionEmptyReason])[] =
		[
			["unknown channel", {}, "160000000000000999", "channel-not-registered"],
			[
				"channel of another guild",
				{ channels: [channel(FOREIGN_CHANNEL, "guild-text", null, "160000000000000777")] },
				FOREIGN_CHANNEL,
				"channel-not-registered"
			],
			["no membership", { membership: null }, CHANNEL, "membership-not-registered"],
			[
				"membership of another guild",
				{ membership: { guildId: "160000000000000777", userId: USER, roleIds: [] } },
				CHANNEL,
				"membership-not-registered"
			],
			[
				"membership of another user",
				{ membership: { guildId: GUILD, userId: OTHER_USER, roleIds: [] } },
				CHANNEL,
				"membership-not-registered"
			],
			["no guild row", { guildId: "160000000000000777" }, CHANNEL, "guild-not-registered"],
			["no @everyone row", { everyone: null }, CHANNEL, "everyone-role-not-registered"],
			[
				"private thread with no stored edge",
				{ channels: [channel(PRIVATE_THREAD, "private-thread", PARENT), channel(PARENT)] },
				PRIVATE_THREAD,
				"private-thread-not-admitted"
			]
		];

	it.each(refusals)("refuses %s with the empty set rather than an error", (_name, fixture, channelId, reason) => {
		const derived = evaluate(fixture, channelId);
		expect(derived.status).toBe("empty");
		expect(derived.reason).toBe(reason);
		expect(derived.permissions.bitfield).toBe("0");
		expect(derived.permissions.has("view-channel")).toBe(false);
		expect(derived.administratorBypass).toBe(false);
		expect(derived.overwriteLevels).toEqual([]);
	});

	it("names every reason the type allows, so a new fail-closed case cannot go untested", () => {
		const named: readonly EffectivePermissionEmptyReason[] = [
			"guild-not-registered",
			"channel-not-registered",
			"membership-not-registered",
			"everyone-role-not-registered",
			"private-thread-not-admitted"
		];
		const seen = new Set<EffectivePermissionEmptyReason>();
		for (const [, fixture, channelId] of refusals) {
			const reason = evaluate(fixture, channelId).reason;
			if (reason !== null) {
				seen.add(reason);
			}
		}
		expect([...named].sort()).toEqual([...seen].sort());
	});
});

describe("evaluation is a pure derivation (R13)", () => {
	it("answers identically twice and leaves its snapshot untouched", () => {
		const built = snapshot({
			everyone: String(VIEW),
			membership: { guildId: GUILD, userId: USER, roleIds: [ROLE_BACKEND] },
			roles: [role(ROLE_BACKEND, String(HISTORY))],
			overwrites: [[CHANNEL, [overwrite(EVERYONE, "role", 0n, MENTION), overwrite(USER, "member", MENTION)]]]
		});
		const before = JSON.stringify(built);
		const first = deriveEffectivePermissions({ guildId: GUILD, userId: USER, channelId: CHANNEL, snapshot: built });
		const second = deriveEffectivePermissions({
			guildId: GUILD,
			userId: USER,
			channelId: CHANNEL,
			snapshot: built
		});
		// The two answers are the same decision; `has` is a fresh closure each time, so the fields that carry
		// the result are compared, not the function identity.
		expect(second.status).toBe(first.status);
		expect(second.reason).toBe(first.reason);
		expect(second.permissions.granted).toEqual(first.permissions.granted);
		expect(second.permissions.bitfield).toBe(first.permissions.bitfield);
		expect(JSON.stringify(built)).toBe(before);
	});

	it("reports the granted names in ascending bit order and nothing else", () => {
		const derived = evaluate({ everyone: String(HISTORY | VIEW) });
		expect(derived.permissions.granted).toEqual(["view-channel", "read-message-history"]);
	});

	it("refuses to render a bitfield a caller could not have supplied", () => {
		// R13's rejected input shape is enforced by the input type: an extra field is a type error, and a
		// snapshot holding a non-Discord bitfield text is a technical failure, not a partial grant.
		expect(() =>
			deriveEffectivePermissions({
				guildId: GUILD,
				userId: USER,
				channelId: CHANNEL,
				snapshot: snapshot({ everyone: "0x100" as never })
			})
		).toThrow();
	});
});

describe("one bounded registry-wide pass (Contracts: never a per-channel round trip)", () => {
	it("evaluates every stored channel from the same snapshot, in the read's own order", () => {
		const built = snapshot({
			everyone: String(VIEW),
			channels: [channel(CHANNEL), channel(PARENT), channel(THREAD, "public-thread", PARENT)],
			overwrites: [[PARENT, [overwrite(EVERYONE, "role", 0n, VIEW)]]]
		});
		const scanned: readonly RegistryChannelDerivation[] = scanEffectivePermissionsAcrossRegistry({
			guildId: GUILD,
			userId: USER,
			snapshot: built
		});
		expect(scanned.map((entry) => entry.channel.channelId)).toEqual([CHANNEL, PARENT, THREAD]);
		expect(scanned.map((entry) => entry.derivation.permissions.has("view-channel"))).toEqual([true, false, false]);
		// The thread inherits its parent's deny through the same derivation, with no extra read.
		expect(scanned[2]?.derivation.overwriteLevels).toEqual([PARENT, THREAD]);
		expect(built.overwriteSets.length).toBe(3);
	});

	it("reports the distinct refusal reasons of a scan that granted nothing", () => {
		const derivations = scanEffectivePermissionsAcrossRegistry({
			guildId: GUILD,
			userId: USER,
			snapshot: snapshot({ membership: null, channels: [channel(CHANNEL), channel(PARENT)] })
		});
		expect(distinctRefusalReasons(derivations.map((entry) => entry.derivation))).toEqual([
			"membership-not-registered"
		]);
		expect(distinctRefusalReasons([])).toEqual(["channel-not-registered"]);
		// A scan in which at least one channel produced a real decision reports no reasons: the list itself
		// is the answer, and a partly-refusing registry is not a fail-closed registry.
		const partlyEvaluated = scanEffectivePermissionsAcrossRegistry({
			guildId: GUILD,
			userId: USER,
			snapshot: snapshot({
				channels: [channel(CHANNEL), channel(PRIVATE_THREAD, "private-thread", PARENT), channel(PARENT)],
				privateThreadIds: []
			})
		});
		expect(distinctRefusalReasons(partlyEvaluated.map((entry) => entry.derivation))).toEqual([]);

		// A scan in which every stored row refused for one reason names that reason and nothing else. Note the
		// contrast with the case above: a channel evaluated down to an empty set is a real decision, so a
		// registry that holds only private threads this user is not in reports the admission refusal instead
		// of an unexplained empty list (R8).
		const allPrivate = scanEffectivePermissionsAcrossRegistry({
			guildId: GUILD,
			userId: USER,
			snapshot: snapshot({
				channels: [
					channel(PRIVATE_THREAD, "private-thread", PARENT),
					channel(THREAD, "private-thread", PARENT)
				],
				privateThreadIds: []
			})
		});
		expect(distinctRefusalReasons(allPrivate.map((entry) => entry.derivation))).toEqual([
			"private-thread-not-admitted"
		]);
	});

	it("agrees with the single-channel decision for the same channel and state (R12)", () => {
		const built = snapshot({
			everyone: String(VIEW | HISTORY),
			overwrites: [[CHANNEL, [overwrite(USER, "member", 0n, HISTORY)]]]
		});
		const scanned = scanEffectivePermissionsAcrossRegistry({ guildId: GUILD, userId: USER, snapshot: built });
		const single = deriveEffectivePermissions({
			guildId: GUILD,
			userId: USER,
			channelId: CHANNEL,
			snapshot: built
		});
		expect(scanned[0]?.derivation.permissions.bitfield).toBe(single.permissions.bitfield);
		expect(bitsIncludePermission(BigInt(single.permissions.bitfield), "view-channel")).toBe(true);
	});
});
