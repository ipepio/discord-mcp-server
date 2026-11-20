import { describe, expect, it } from "vitest";
import {
	ALL_DISCORD_PERMISSION_BITS,
	DISCORD_PERMISSION_NAMES,
	DiscordPermissionBits,
	bitsIncludePermission,
	discordPermissionBit,
	permissionsInBits
} from "../../../src/features/guild-state/models/domain/discord-permissions.js";

/**
 * The named permission table (docs/features/guild-state.md R3, R12; Contracts). This is the security core's
 * vocabulary, so a wrong name-to-value pair is a silent grant or a silent denial somewhere else: these
 * expectations are written as literal decimal text, taken from Discord's documented bit positions, and are
 * NOT derived from the table under test. That is the point — a table that drifted would otherwise be
 * self-confirming.
 *
 * The reference the values were cross-checked against is the `PermissionFlagsBits` table shipped by the
 * `discord-api-types` package the pinned `discord.js` depends on; `odd/tasks/guild-state.md` T7's audit
 * record says every entry matched. The two documented aliases of one bit (`ManageEmojisAndStickers`,
 * `ManageGuildExpressions`) appear once, and no bit Discord has not documented is named here.
 */

/** Discord's documented bit positions, as exact decimal text — the expectation, not the implementation. */
const DOCUMENTED_BITS: readonly (readonly [string, string])[] = Object.freeze([
	["create-instant-invite", "1"],
	["kick-members", "2"],
	["ban-members", "4"],
	["administrator", "8"],
	["manage-channels", "16"],
	["manage-guild", "32"],
	["add-reactions", "64"],
	["view-audit-log", "128"],
	["priority-speaker", "256"],
	["stream", "512"],
	["view-channel", "1024"],
	["send-messages", "2048"],
	["send-tts-messages", "4096"],
	["manage-messages", "8192"],
	["embed-links", "16384"],
	["attach-files", "32768"],
	["read-message-history", "65536"],
	["mention-everyone", "131072"],
	["use-external-emojis", "262144"],
	["view-guild-insights", "524288"],
	["connect", "1048576"],
	["speak", "2097152"],
	["mute-members", "4194304"],
	["deafen-members", "8388608"],
	["move-members", "16777216"],
	["use-vad", "33554432"],
	["change-nickname", "67108864"],
	["manage-nicknames", "134217728"],
	["manage-roles", "268435456"],
	["manage-webhooks", "536870912"],
	["manage-guild-expressions", "1073741824"],
	["use-application-commands", "2147483648"],
	["request-to-speak", "4294967296"],
	["manage-events", "8589934592"],
	["manage-threads", "17179869184"],
	["create-public-threads", "34359738368"],
	["create-private-threads", "68719476736"],
	["use-external-stickers", "137438953472"],
	["send-messages-in-threads", "274877906944"],
	["use-embedded-activities", "549755813888"],
	["moderate-members", "1099511627776"],
	["view-creator-monetization-analytics", "2199023255552"],
	["use-soundboard", "4398046511104"],
	["create-guild-expressions", "8796093022208"],
	["create-events", "17592186044416"],
	["use-external-sounds", "35184372088832"],
	["send-voice-messages", "70368744177664"],
	["set-voice-channel-status", "281474976710656"],
	["send-polls", "562949953421312"],
	["use-external-apps", "1125899906842624"],
	["pin-messages", "2251799813685248"],
	["bypass-slowmode", "4503599627370496"]
]);

describe("discord permission bit table (R3, Contracts)", () => {
	it("names every documented bit with the documented value", () => {
		expect(DOCUMENTED_BITS.length).toBe(52);
		for (const [name, decimal] of DOCUMENTED_BITS) {
			expect(String(bitOf(name)), name).toBe(decimal);
		}
	});

	it("names nothing the table above does not name", () => {
		expect([...DISCORD_PERMISSION_NAMES].sort()).toEqual(DOCUMENTED_BITS.map(([name]) => name).sort());
	});

	it("keeps one value per bit, so an alias cannot split a permission into two names", () => {
		const values = DISCORD_PERMISSION_NAMES.map((name) => DiscordPermissionBits[name]);
		expect(new Set(values).size).toBe(values.length);
	});

	it("uses powers of two and nothing else", () => {
		for (const name of DISCORD_PERMISSION_NAMES) {
			const bit = DiscordPermissionBits[name];
			expect(bit > 0n && (bit & (bit - 1n)) === 0n, name).toBe(true);
		}
	});

	it("names the bypass bit and the two bits the query surface filters on", () => {
		// These four are the only bits this feature's rules depend on by name, so they are asserted alone too.
		expect(discordPermissionBit("administrator")).toBe(8n);
		expect(discordPermissionBit("view-channel")).toBe(1024n);
		expect(discordPermissionBit("read-message-history")).toBe(65536n);
		expect(discordPermissionBit("manage-threads")).toBe(17179869184n);
		expect(discordPermissionBit("manage-roles")).toBe(268435456n);
	});
});

describe("bit arithmetic over the table (R3: no numeric coercion)", () => {
	it("answers a named lookup for a bit stored as text the union of two numbers would carry exactly", () => {
		const bits = discordPermissionBit("use-external-apps") | discordPermissionBit("pin-messages");
		expect(bitsIncludePermission(bits, "use-external-apps")).toBe(true);
		expect(bitsIncludePermission(bits, "pin-messages")).toBe(true);
		expect(bitsIncludePermission(bits, "view-channel")).toBe(false);
		// Both bits are above the safe-integer range as a union: the exact text is what the query renders.
		expect(bits.toString()).toBe("3377699720527872");
	});

	it("lists the permissions a value contains, in ascending bit order", () => {
		const bits = discordPermissionBit("read-message-history") | discordPermissionBit("view-channel");
		expect(permissionsInBits(bits)).toEqual(["view-channel", "read-message-history"]);
		expect(permissionsInBits(0n)).toEqual([]);
	});

	it("grants every named permission when the whole table is folded", () => {
		expect(permissionsInBits(ALL_DISCORD_PERMISSION_BITS).length).toBe(DISCORD_PERMISSION_NAMES.length);
		for (const name of DISCORD_PERMISSION_NAMES) {
			expect(bitsIncludePermission(ALL_DISCORD_PERMISSION_BITS, name), name).toBe(true);
		}
		// 2^52 is the highest documented bit, so the union reaches it and stays under the next one.
		expect(ALL_DISCORD_PERMISSION_BITS >= 2n ** 52n).toBe(true);
		expect(ALL_DISCORD_PERMISSION_BITS < 2n ** 53n).toBe(true);
	});

	it("treats a bit Discord has not documented as a permission nobody holds", () => {
		// A future or bogus high bit can arrive as stored text. It must never answer a named lookup true,
		// and it must never be reported as a granted permission name: fail closed, by name and by value.
		const unDocumented = 2n ** 53n;
		for (const name of DISCORD_PERMISSION_NAMES) {
			expect(bitsIncludePermission(unDocumented, name), name).toBe(false);
		}
		expect(permissionsInBits(unDocumented)).toEqual([]);
	});
});

/** The bit a documented name stands for, read through the table's own key type. */
function bitOf(name: string): bigint {
	if (!(name in DiscordPermissionBits)) {
		throw new Error(`unknown permission name in the test table: ${name}`);
	}
	return DiscordPermissionBits[name as keyof typeof DiscordPermissionBits];
}
