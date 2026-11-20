/**
 * Application-level names for the numeric Discord resource types (spec R3). The codes are the ones the
 * Gateway sends; the names are what consumers store and what the query surface reports. A code outside
 * the table becomes `unknown` rather than being dropped or guessed at: the transport names what it can
 * name and says it does not know otherwise.
 */

export type NormalizedMessageType =
	| "default"
	| "recipient-add"
	| "recipient-remove"
	| "call"
	| "channel-name-change"
	| "channel-icon-change"
	| "pinned-message"
	| "member-join"
	| "guild-boost"
	| "guild-boost-tier-1"
	| "guild-boost-tier-2"
	| "guild-boost-tier-3"
	| "channel-follow-add"
	| "guild-discovery-disqualified"
	| "guild-discovery-requalified"
	| "guild-discovery-grace-period-initial-warning"
	| "guild-discovery-grace-period-final-warning"
	| "thread-created"
	| "reply"
	| "chat-input-command"
	| "thread-starter-message"
	| "guild-invite-reminder"
	| "context-menu-command"
	| "auto-moderation-action"
	| "role-subscription-purchase"
	| "interaction-premium-upsell"
	| "stage-start"
	| "stage-end"
	| "stage-speaker"
	| "stage-raise-hand"
	| "stage-topic"
	| "guild-application-premium-subscription"
	| "guild-incident-alert-mode-enabled"
	| "guild-incident-alert-mode-disabled"
	| "guild-incident-report-raid"
	| "guild-incident-report-false-alarm"
	| "purchase-notification"
	| "poll-result"
	| "unknown";

const MESSAGE_TYPE_NAMES: Readonly<Record<number, NormalizedMessageType>> = Object.freeze({
	0: "default",
	1: "recipient-add",
	2: "recipient-remove",
	3: "call",
	4: "channel-name-change",
	5: "channel-icon-change",
	6: "pinned-message",
	7: "member-join",
	8: "guild-boost",
	9: "guild-boost-tier-1",
	10: "guild-boost-tier-2",
	11: "guild-boost-tier-3",
	12: "channel-follow-add",
	14: "guild-discovery-disqualified",
	15: "guild-discovery-requalified",
	16: "guild-discovery-grace-period-initial-warning",
	17: "guild-discovery-grace-period-final-warning",
	18: "thread-created",
	19: "reply",
	20: "chat-input-command",
	21: "thread-starter-message",
	22: "guild-invite-reminder",
	23: "context-menu-command",
	24: "auto-moderation-action",
	25: "role-subscription-purchase",
	26: "interaction-premium-upsell",
	27: "stage-start",
	28: "stage-end",
	29: "stage-speaker",
	30: "stage-raise-hand",
	31: "stage-topic",
	32: "guild-application-premium-subscription",
	36: "guild-incident-alert-mode-enabled",
	37: "guild-incident-alert-mode-disabled",
	38: "guild-incident-report-raid",
	39: "guild-incident-report-false-alarm",
	44: "purchase-notification",
	46: "poll-result"
});

export type NormalizedChannelType =
	| "guild-text"
	| "dm"
	| "guild-voice"
	| "group-dm"
	| "guild-category"
	| "guild-announcement"
	| "announcement-thread"
	| "public-thread"
	| "private-thread"
	| "guild-stage-voice"
	| "guild-directory"
	| "guild-forum"
	| "guild-media"
	| "unknown";

const CHANNEL_TYPE_NAMES: Readonly<Record<number, NormalizedChannelType>> = Object.freeze({
	0: "guild-text",
	1: "dm",
	2: "guild-voice",
	3: "group-dm",
	4: "guild-category",
	5: "guild-announcement",
	10: "announcement-thread",
	11: "public-thread",
	12: "private-thread",
	13: "guild-stage-voice",
	14: "guild-directory",
	15: "guild-forum",
	16: "guild-media"
});

/** Thread channel types: what makes a `CHANNEL_*` payload a thread rather than a channel. */
const THREAD_CHANNEL_CODES: readonly number[] = [10, 11, 12];

export type NormalizedOverwriteTargetType = "role" | "member";

/** Permission overwrite type codes: 0 role, 1 member. */
const OVERWRITE_TARGET_TYPES: Readonly<Record<number, NormalizedOverwriteTargetType>> = Object.freeze({
	0: "role",
	1: "member"
});

export function messageTypeNameFor(code: number): NormalizedMessageType {
	return MESSAGE_TYPE_NAMES[code] ?? "unknown";
}

export function channelTypeNameFor(code: number): NormalizedChannelType {
	return CHANNEL_TYPE_NAMES[code] ?? "unknown";
}

export function isThreadChannelCode(code: number): boolean {
	return THREAD_CHANNEL_CODES.includes(code);
}

export function overwriteTargetTypeFor(code: number): NormalizedOverwriteTargetType | undefined {
	return OVERWRITE_TARGET_TYPES[code];
}
