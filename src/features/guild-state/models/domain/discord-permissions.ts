/**
 * Discord's documented permission bits, named (docs/features/guild-state.md R3, R12; docs/adr/0005).
 *
 * Nothing here is invented. The values are Discord's own bit positions, cross-checked against the
 * `PermissionFlags` table shipped by the `discord-api-types` package that this repository's pinned
 * `discord.js` depends on (`payloads/common.js`), and `tests/features/guild-state/discord-permissions.test.ts`
 * asserts the decimal text of every one of them — a table that drifted from Discord's documentation would
 * otherwise silently move a grant. Two documented aliases of one bit (`ManageEmojisAndStickers` and
 * `ManageGuildExpressions`) appear once, under the name still in use.
 *
 * The names are kebab-case application names, because this is the feature's vocabulary for a bit, not a
 * transport field: a consumer of `EvaluateEffectivePermissionsQuery` asks "may this user view the channel",
 * and the answer is a named lookup over the bit below.
 *
 * `bigint` is the internal currency of evaluation (docs/adr/0005, O2 — decided by T7). The text a repository
 * stores is converted exactly once, in `permission-bitfield.ts`, and a permission value never passes through
 * a JavaScript number, which would lose every bit above 2^53 (R3). `UseExternalApps` and `PinMessages` are
 * the proof by example: both are larger than `Number.MAX_SAFE_INTEGER`.
 */
export const DiscordPermissionBits = Object.freeze({
	"create-instant-invite": 1n,
	"kick-members": 2n,
	"ban-members": 4n,
	/** R3's bypass bit: it dominates every other permission and skips the overwrite stages. */
	administrator: 8n,
	"manage-channels": 16n,
	"manage-guild": 32n,
	"add-reactions": 64n,
	"view-audit-log": 128n,
	"priority-speaker": 256n,
	stream: 512n,
	/** R12 and the query surface's visibility bit: the one `ListUserAccessibleChannelsQuery` filters on. */
	"view-channel": 1024n,
	"send-messages": 2048n,
	"send-tts-messages": 4096n,
	"manage-messages": 8192n,
	"embed-links": 16384n,
	"attach-files": 32768n,
	/** The second bit the query surface names: read alongside `view-channel` (docs/features/query.md). */
	"read-message-history": 65536n,
	"mention-everyone": 131072n,
	"use-external-emojis": 262144n,
	"view-guild-insights": 524288n,
	connect: 1048576n,
	speak: 2097152n,
	"mute-members": 4194304n,
	"deafen-members": 8388608n,
	"move-members": 16777216n,
	"use-vad": 33554432n,
	"change-nickname": 67108864n,
	"manage-nicknames": 134217728n,
	"manage-roles": 268435456n,
	"manage-webhooks": 536870912n,
	"manage-guild-expressions": 1073741824n,
	"use-application-commands": 2147483648n,
	"request-to-speak": 4294967296n,
	"manage-events": 8589934592n,
	"manage-threads": 17179869184n,
	"create-public-threads": 34359738368n,
	"create-private-threads": 68719476736n,
	"use-external-stickers": 137438953472n,
	"send-messages-in-threads": 274877906944n,
	"use-embedded-activities": 549755813888n,
	"moderate-members": 1099511627776n,
	"view-creator-monetization-analytics": 2199023255552n,
	"use-soundboard": 4398046511104n,
	"create-guild-expressions": 8796093022208n,
	"create-events": 17592186044416n,
	"use-external-sounds": 35184372088832n,
	"send-voice-messages": 70368744177664n,
	"set-voice-channel-status": 281474976710656n,
	"send-polls": 562949953421312n,
	"use-external-apps": 1125899906842624n,
	"pin-messages": 2251799813685248n,
	"bypass-slowmode": 4503599627370496n
});

/** One named permission of the table above. */
export type DiscordPermission = keyof typeof DiscordPermissionBits;

/** Every named permission, in ascending bit order — the order {@link ALL_DISCORD_PERMISSION_BITS} folds in. */
export const DISCORD_PERMISSION_NAMES: readonly DiscordPermission[] = Object.freeze(
	(Object.entries(DiscordPermissionBits) as [DiscordPermission, bigint][])
		.sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name]) => name)
);

/**
 * The union of every documented bit. This is what the derivation's stage 2 means by "every permission is
 * granted": an {@link administrator} base is rendered as exactly this set, so every named lookup answers true
 * and no bit outside Discord's documented table can appear.
 */
export const ALL_DISCORD_PERMISSION_BITS: bigint = DISCORD_PERMISSION_NAMES.reduce<bigint>(
	(bits, name) => bits | DiscordPermissionBits[name],
	0n
);

/** The bit a name stands for. Unknown names cannot reach this: the parameter is the union type. */
export function discordPermissionBit(permission: DiscordPermission): bigint {
	return DiscordPermissionBits[permission];
}

/** True when the exact bit is set in `bits`. Bit arithmetic only, never a numeric coercion (R3). */
export function bitsIncludePermission(bits: bigint, permission: DiscordPermission): boolean {
	return (bits & DiscordPermissionBits[permission]) === DiscordPermissionBits[permission];
}

/** The named permissions present in `bits`, in ascending bit order. */
export function permissionsInBits(bits: bigint): readonly DiscordPermission[] {
	return DISCORD_PERMISSION_NAMES.filter((permission) => bitsIncludePermission(bits, permission));
}
