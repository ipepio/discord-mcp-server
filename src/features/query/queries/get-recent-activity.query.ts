import type { StoredMessage } from "../models/domain/message.js";
import type { ToolInput } from "../models/domain/tool-input.js";
import type { ActivityWindow, MessageResult, ToolResult } from "../models/domain/tool-result.js";
import type {
	ActivityReadRepository,
	ActivityWindowScope,
	MessageReadScope
} from "../repositories/message-read.repository.js";
import type { QueryAccess, QueryAccessPolicy, QueryChannel } from "./query-access.policy.js";
import { readBotViewableChannelIds } from "./bot-access.js";
import type { BotViewableChannelsReader } from "./bot-access.js";
import { decodeCursor } from "./query-cursor.js";
import { messageResults, readMessages } from "./message-results.js";
import { QueryError } from "../models/domain/query.errors.js";

import { QueryPayloadPolicy } from "./query-payload.policy.js";
import type { DigestGroupDraft } from "./query-payload.policy.js";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `get_recent_activity` (R14): the one-call multi-channel novelty digest, owner decision D3
 * ("mira los últimos mensajes (podría ser desde el último mensaje que envió el usuario)").
 *
 * The window is `[lowerBound, now]`, inclusive at both ends, where `now` is the query-time instant from the
 * injected clock and the lower bound is decided by one of three rules, reported back as `window.anchor`:
 * an explicit `since`, the Requester's own newest authored message ("my-last-message", O7: no such message
 * means a valid empty digest), or `now - 24h`. The scope is R12's intersection — the Requester's
 * `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY` entries **and** the bot-viewable ones — optionally narrowed to one
 * container by `channelId`. Containers outside it are never mentioned, not even as an empty group (R3), and a
 * container outside it and a container that was merely quiet produce the same empty digest.
 *
 * Work is bounded by construction: one grouped count over the scope set, one partitioned page read, and in
 * anchor mode one anchor lookup — a constant number of statements, never a loop per container. The hub keeps
 * no per-user read state (S7): novelty is time/anchor based only, and the "ask when ambiguous" obligation is
 * R15's instruction text, not a tool-side question.
 */
export class GetRecentActivityQuery {
	public constructor(
		private readonly access: QueryAccessPolicy,
		private readonly bot: BotViewableChannelsReader,
		private readonly botUserId: string,
		private readonly messages: ActivityReadRepository,
		private readonly payload = new QueryPayloadPolicy(),
		private readonly clock: () => Date = () => new Date()
	) {}
	public async execute(input: ToolInput & { readonly userId: string }): Promise<ToolResult> {
		// R14: one window per call. The published schema already rejects the pair; stating it here keeps the use
		// case honest for any caller that reaches it without the adapter.
		if (input.since !== undefined && input.sinceByMyLastMessage !== undefined)
			throw new QueryError("invalid_input", "Invalid field: since");
		const decoded = decodeCursor("get_recent_activity", input);
		const before =
			decoded?.createdAt && decoded.messageId
				? { createdAt: decoded.createdAt, messageId: decoded.messageId }
				: undefined;
		// R11's status gate runs inside `resolve`, before anything is read; the gate is R2's content gate.
		const access = await this.access.resolve(input.userId, "content");
		const botViewable = await readBotViewableChannelIds(this.bot, this.botUserId);
		const intersection = access.channels.filter((channel) => botViewable.has(channel.channelId));
		const scoped = input.channelId
			? intersection.filter((channel) => channel.channelId === input.channelId)
			: intersection;
		const window = await this.resolveWindow(input, access.guildId, scoped);
		// O7: no anchor message is a valid empty digest that says so, never a silent fallback to 24 hours.
		if (window.since === null) return { data: [], window };
		if (scoped.length === 0) return { data: [], window };
		const scope: ActivityWindowScope = {
			guildId: access.guildId,
			accessibleChannelIds: scoped.map((channel) => channel.channelId),
			since: window.since,
			until: this.now()
		};
		const [counts, rows] = await Promise.all([
			readMessages(() => this.messages.countWindowMessages({ ...scope, ...(before ? { before } : {}) })),
			readMessages(() =>
				this.messages.readActivityPage({
					...scope,
					pageSize: input.pageSize,
					...(before ? { before } : {})
				})
			)
		]);
		const byChannel = new Map<string, MessageResult[]>();
		// The partitioned read returns `pageSize + 1` rows per container (R4's probe); the page is `pageSize`.
		for (const group of groupRows(rows, access))
			byChannel.set(group.channelId, group.messages.slice(0, input.pageSize));
		const drafts = counts
			.filter((count) => count.messageCount > 0)
			.flatMap((count): DigestGroupDraft[] => {
				const channel = scoped.find((candidate) => candidate.channelId === count.channelId);
				const messages = byChannel.get(count.channelId) ?? [];
				const newest = messages[0];
				if (!channel || !newest) throw new QueryError("internal_error", "Invalid digest group");
				return [
					{
						channelId: channel.channelId,
						channelName: channel.name,
						parentChannelId: channel.parentChannelId,
						messageCount: count.messageCount,
						messages,
						newest: { createdAt: newest.createdAt, messageId: newest.messageId }
					}
				];
			})
			// Newest returned message first, `channelId` ascending as tie-breaker (R14's group order). The
			// ordering is fixed before the byte cap trims anything, so shortening never reorders the digest.
			.sort(
				(a, b) =>
					Date.parse(b.newest.createdAt) - Date.parse(a.newest.createdAt) ||
					(BigInt(a.channelId) < BigInt(b.channelId) ? -1 : 1)
			);
		return this.payload.boundDigest(input, window, drafts);
	}

	private now(): string {
		const at = this.clock();
		if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
			throw new QueryError("internal_error", "Invalid query clock");
		return at.toISOString();
	}

	/** R14's effective window, with the anchor rule it used reported back to the client. */
	private async resolveWindow(
		input: ToolInput & { readonly userId: string },
		guildId: string,
		scoped: readonly QueryChannel[]
	): Promise<ActivityWindow> {
		if (input.since !== undefined)
			return { since: new Date(Date.parse(input.since)).toISOString(), anchor: "since" };
		if (input.sinceByMyLastMessage !== undefined) {
			const scope: MessageReadScope & { readonly authorId: string } = {
				guildId,
				accessibleChannelIds: scoped.map((channel) => channel.channelId),
				authorId: input.userId
			};
			// The maximum over the whole mirrored set when no container narrows it: the scope set *is* what the
			// Requester may read and the bot mirrors, so its maximum is the owner's "último mensaje que envió".
			const anchor = await readMessages(() => this.messages.readMyLastMessageAt(scope));
			return { since: anchor, anchor: "my-last-message" };
		}
		return { since: new Date(Date.parse(this.now()) - DEFAULT_WINDOW_MS).toISOString(), anchor: "default-24h" };
	}
}

/** The partitioned read's rows, grouped in the container order the read produced, recent-first inside each. */
function groupRows(
	rows: readonly StoredMessage[],
	access: QueryAccess
): readonly { readonly channelId: string; readonly messages: MessageResult[] }[] {
	const groups: { channelId: string; messages: MessageResult[] }[] = [];
	for (const message of messageResults(rows, access)) {
		const current = groups.at(-1);
		if (current && current.channelId === message.channelId) current.messages.push(message);
		else groups.push({ channelId: message.channelId, messages: [message] });
	}
	return groups;
}
