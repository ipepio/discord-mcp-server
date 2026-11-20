import { QueryError } from "../domain/query.errors.js";
import { QUERY_TOOL_NAMES } from "../domain/tool-input.js";
import { GUILD_REGISTRY_STATUSES } from "../../../guild-state/index.js";
import type { QueryToolName, ToolInput } from "../domain/tool-input.js";

interface FieldSchema {
	readonly type: "string" | "integer" | "boolean";
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly format?: "date-time";
	readonly default?: number;
}
const id: FieldSchema = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
const instant: FieldSchema = { type: "string", format: "date-time" };
const pageSize: FieldSchema = { type: "integer", minimum: 1, maximum: 100, default: 20 };
const cursor: FieldSchema = { type: "string", minLength: 1, maxLength: 4096 };
const paging = { pageSize, cursor };
const inputs: Record<
	QueryToolName,
	{ readonly required: readonly string[]; readonly properties: Readonly<Record<string, FieldSchema>> }
> = {
	search_messages: {
		required: ["query"],
		properties: {
			query: { type: "string", minLength: 1, maxLength: 1000 },
			channelId: id,
			authorId: id,
			from: instant,
			to: instant,
			...paging
		}
	},
	list_channels: { required: [], properties: paging },
	get_channel_history: {
		required: ["channelId"],
		properties: { channelId: id, from: instant, to: instant, ...paging }
	},
	get_thread_messages: { required: ["threadId"], properties: { threadId: id, ...paging } },
	get_message_context: { required: ["messageId"], properties: { messageId: id, windowSize: pageSize } },
	// R14: one scope per call and one window per call; `channelId` and `categoryId` never travel together
	// because O4's registry evidence kept the digest channel-scoped (docs/features/query.md).
	get_recent_activity: {
		required: [],
		properties: {
			channelId: id,
			since: instant,
			sinceByMyLastMessage: { type: "boolean" },
			...paging
		}
	},
	// R17: the empty closed object — no identity, no filter, no page. Any supplied field is `invalid_input`.
	get_hub_status: { required: [], properties: {} }
};
const messageProperties = {
	messageId: id,
	guildId: id,
	channelId: id,
	channelName: { type: "string" },
	parentChannelId: { anyOf: [id, { type: "null" }] },
	authorId: id,
	authorDisplayName: { type: ["string", "null"] },
	createdAt: instant,
	editedAt: { anyOf: [instant, { type: "null" }] },
	messageType: { type: "string" },
	replyToMessageId: { anyOf: [id, { type: "null" }] },
	content: { type: "string" },
	contentLength: { type: "integer", minimum: 0 },
	truncated: { type: "boolean" },
	attachments: {
		type: "array",
		items: {
			type: "object",
			additionalProperties: false,
			required: ["attachmentId", "filename", "contentType", "sizeBytes", "url"],
			properties: {
				attachmentId: id,
				filename: { type: "string" },
				contentType: { type: ["string", "null"] },
				sizeBytes: { type: "integer", minimum: 0 },
				url: { type: "string" }
			}
		}
	}
};
const messageSchema = {
	type: "object",
	additionalProperties: false,
	required: Object.keys(messageProperties),
	properties: messageProperties
};
const channelProperties = {
	channelId: id,
	name: { type: "string" },
	kind: { enum: ["channel", "thread"] },
	parentChannelId: { anyOf: [id, { type: "null" }] },
	position: { type: "integer" }
};
const pagination = {
	type: "object",
	additionalProperties: false,
	required: ["pageSize", "hasNext", "nextCursor"],
	properties: { pageSize, hasNext: { type: "boolean" }, nextCursor: { type: ["string", "null"] } }
};
const activityGroupProperties = {
	channelId: id,
	channelName: { type: "string" },
	parentChannelId: { anyOf: [id, { type: "null" }] },
	messageCount: { type: "integer", minimum: 0 },
	returnedCount: { type: "integer", minimum: 0 },
	messages: { type: "array", items: messageSchema },
	pagination
};
const activityWindow = {
	type: "object",
	additionalProperties: false,
	required: ["since", "anchor"],
	properties: {
		since: { anyOf: [instant, { type: "null" }] },
		anchor: { enum: ["since", "my-last-message", "default-24h"] }
	}
};
// R17's fourth envelope: one status object instead of a page. O11 and O12 widened two members to `null`
// (`guild` while the registry holds no Guild row, the count while the status is not current), which is the
// declared shape of docs/features/query.md "Implementation resolutions (2026-11-12)".
const hubStatusProperties = {
	guild: {
		type: "object",
		additionalProperties: false,
		required: ["name", "id"],
		properties: { name: { type: ["string", "null"] }, id: { anyOf: [id, { type: "null" }] } }
	},
	registry: {
		type: "object",
		additionalProperties: false,
		required: ["status"],
		properties: { status: { enum: GUILD_REGISTRY_STATUSES } }
	},
	mirror: {
		type: "object",
		additionalProperties: false,
		required: ["visibleAndMirroredChannelCount"],
		properties: {
			visibleAndMirroredChannelCount: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }
		}
	}
};
const errorSchema = {
	type: "object",
	additionalProperties: false,
	required: ["code", "message", "retryable"],
	properties: {
		code: { enum: ["invalid_input", "state_unavailable", "internal_error"] },
		message: { type: "string" },
		retryable: { type: "boolean" }
	}
};
// R15's required text for every tool, verbatim from docs/features/query.md "Required tool descriptions":
// the published descriptions are contract, so a client that never shows `instructions` still learns the
// default order, the intersection and the ambiguity rule.
const descriptions: Record<QueryToolName, string> = {
	search_messages:
		"Find messages by topic across the channels this person can read and the hub actually mirrors. " +
		"Best match first. Use it to locate a discussion, then get_message_context to read around a hit. " +
		"Read only.",
	list_channels:
		"List the channels and threads this person can read AND the hub actually mirrors. Only channels " +
		"from this list can return messages; a channel that is missing is missing for a reason this tool " +
		"will not reveal. A short list is this hub's mirror scope, not a pagination defect — get_hub_status " +
		"reports how many entries that is. Read only.",
	get_channel_history:
		"Read one channel or thread newest first, paging back in time with the cursor. Pass from/to for an " +
		"explicit range. Read only.",
	get_thread_messages: "Read one thread newest first, paging back in time with the cursor. Read only.",
	get_message_context: "Read a bounded window of messages around one message, oldest to newest. Read only.",
	get_recent_activity:
		"Get what is new in one call: recent messages grouped by channel, with per-channel counts and cursors. " +
		"Defaults to the last 24 hours, or starts after this person's own last message. " +
		"If the person named neither a channel/category nor a time window, ask them before calling. Read only.",
	// R17: the mirror-scope sentence is required text in every locale (R15), naming the tool that answers
	// "is 2 the truth?" instead of leaving the agent to conclude that something is broken.
	get_hub_status:
		"Report this hub's status in one call: the Guild it serves, whether its registry state is current, " +
		"and how many channels and threads the hub mirrors for this person. A short list_channels page is " +
		"the mirror scope, not a pagination defect. Read only."
};
/**
 * The success envelope of one tool: R17's status object is the fourth documented shape and carries no `data`
 * member, while the five paged tools and the digest do.
 */
function successRequired(name: QueryToolName): readonly string[] {
	if (name === "get_hub_status") return ["guild", "registry", "mirror"];
	if (name === "get_message_context") return ["data"];
	if (name === "search_messages") return ["data", "pagination", "retrieval"];
	if (name === "get_recent_activity") return ["data", "window"];
	return ["data", "pagination"];
}
function pageItems(name: QueryToolName) {
	if (name === "list_channels")
		return {
			type: "object",
			additionalProperties: false,
			required: Object.keys(channelProperties),
			properties: channelProperties
		};
	if (name === "get_recent_activity")
		return {
			type: "object",
			additionalProperties: false,
			required: Object.keys(activityGroupProperties),
			properties: activityGroupProperties
		};
	return messageSchema;
}
function outputProperties(name: QueryToolName) {
	if (name === "get_hub_status")
		// The `data` member is published only for the shared error envelope, where it is always empty; a
		// successful status answer has no page and no pagination (R17).
		return { ...hubStatusProperties, error: errorSchema, data: { type: "array", maxItems: 0 } };
	return {
		data: {
			type: "array",
			// The five paged tools return at most `pageSize` rows; the digest returns one group per active
			// container, bounded by the response byte cap rather than by a page bound (R14, R10).
			...(name === "get_recent_activity" ? {} : { maxItems: 100 }),
			items: pageItems(name)
		},
		...(name === "get_message_context"
			? { anchorMessageId: id, windowTruncated: { type: "boolean" } }
			: name === "get_recent_activity"
				? { window: activityWindow }
				: { pagination }),
		...(name === "get_thread_messages" ? { threadId: id, parentChannelId: id } : {}),
		error: errorSchema,
		...(name === "search_messages" ? { retrieval: { enum: ["hybrid", "full-text-only"] } } : {})
	};
}
export const QUERY_TOOL_SCHEMAS = QUERY_TOOL_NAMES.map((name) => ({
	name,
	description: descriptions[name],
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	inputSchema: { type: "object", additionalProperties: false, ...inputs[name] },
	outputSchema: {
		type: "object",
		additionalProperties: false,
		...(name === "get_hub_status" ? {} : { required: ["data"] }),
		anyOf: [
			{ required: successRequired(name), not: { required: ["error"] } },
			{ required: ["error"], properties: { data: { maxItems: 0 } } }
		],
		properties: outputProperties(name)
	}
}));

/** Validates the exact same closed schema published by tools/list; no separate field allowlist. */
export function parseToolInput(name: QueryToolName, value: unknown): ToolInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("arguments");
	const schema = inputs[name];
	const parsed: Record<string, string | number | boolean> = {};
	for (const [field, candidate] of Object.entries(value)) {
		const rule = schema.properties[field];
		if (!Object.hasOwn(schema.properties, field) || !rule)
			throw new QueryError(
				"invalid_input",
				`Unsupported field: ${field.length > 100 ? field.slice(0, 100) + "…" : field}`
			);
		if (rule.type === "boolean") {
			if (typeof candidate !== "boolean") invalid(field);
		} else if (rule.type === "integer") {
			if (
				typeof candidate !== "number" ||
				!Number.isInteger(candidate) ||
				candidate < (rule.minimum ?? 1) ||
				candidate > (rule.maximum ?? 100)
			)
				invalid(field);
		} else {
			if (
				typeof candidate !== "string" ||
				Array.from(candidate).length < (rule.minLength ?? 0) ||
				Array.from(candidate).length > (rule.maxLength ?? 10000)
			)
				invalid(field);
			if (rule.pattern && (!new RegExp(rule.pattern).test(candidate) || BigInt(candidate) > 9223372036854775807n))
				invalid(field);
			if (
				rule.format &&
				(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate) ||
					!validInstant(candidate))
			)
				invalid(field);
		}
		parsed[field] = candidate;
	}
	for (const required of schema.required) if (!(required in parsed)) invalid(required);
	if (
		typeof parsed["from"] === "string" &&
		typeof parsed["to"] === "string" &&
		Date.parse(parsed["from"]) > Date.parse(parsed["to"])
	)
		invalid("from");
	// R14: one window per call. Naming a field is required, so the earlier-listed one is the one reported.
	if ("since" in parsed && "sinceByMyLastMessage" in parsed) invalid("since");
	return {
		...parsed,
		pageSize: typeof parsed["pageSize"] === "number" ? parsed["pageSize"] : 20,
		windowSize: typeof parsed["windowSize"] === "number" ? parsed["windowSize"] : 20
	};
}
function validInstant(value: string): boolean {
	if (!Number.isFinite(Date.parse(value))) return false;
	const [year, month, day] = value.slice(0, 10).split("-").map(Number);
	if (year === undefined || month === undefined || day === undefined || year < 1 || month < 1 || month > 12)
		return false;
	return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && Number(value.slice(11, 13)) < 24;
}
function invalid(field: string): never {
	throw new QueryError("invalid_input", `Invalid field: ${field}`);
}
