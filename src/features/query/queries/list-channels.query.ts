import type { ToolInput } from "../models/domain/tool-input.js";
import type { ToolResult } from "../models/domain/tool-result.js";
import { decodeCursor, encodeCursor } from "./query-cursor.js";
import type { QueryAccessPolicy } from "./query-access.policy.js";
import { readBotViewableChannelIds } from "./bot-access.js";
import type { BotViewableChannelsReader } from "./bot-access.js";

import { QueryPayloadPolicy } from "./query-payload.policy.js";
import { QueryError } from "../models/domain/query.errors.js";

/** The bot-access seam is shared with R14's digest; re-exported so composition and tests import it here. */
export type { BotViewableChannelsReader };

/**
 * `list_channels` (T2) with the entry set R12 fixes: the **intersection** of the Requester's viewable entries
 * (guild-state's `ListUserAccessibleChannelsQuery`, through {@link QueryAccessPolicy}) and the bot's own
 * viewable entries (the ingestible contract above). No flag is added: a channel the bot does not view is
 * absent exactly as a channel the Requester cannot see is absent, and the two absences are indistinguishable
 * in the payload (R3).
 *
 * Both axes are read from the registry per call, inside one status-gated request (R11), and neither is
 * cached. A failure of either axis is `internal_error` with zero rows: falling back to a single-axis list
 * would silently answer a different question than the one D1 fixed.
 */
export class ListChannelsQuery {
	public constructor(
		private readonly access: QueryAccessPolicy,
		private readonly bot: BotViewableChannelsReader,
		private readonly botUserId: string,
		private readonly payload = new QueryPayloadPolicy()
	) {}
	public async execute(input: ToolInput & { readonly userId: string }): Promise<ToolResult> {
		const after = decodeCursor("list_channels", input);
		// R11's status gate runs inside `resolve`, so a registry that is not current refuses before either
		// axis is evaluated; the Requester's half is the same evaluation R2 already consumed.
		const access = await this.access.resolve(input.userId, "visibility");
		const botViewable = await readBotViewableChannelIds(this.bot, this.botUserId);
		const ordered = access.channels
			.filter((row) => botViewable.has(row.channelId))
			.sort((a, b) => a.position - b.position || (BigInt(a.channelId) < BigInt(b.channelId) ? -1 : 1));
		const rows = ordered
			.filter(
				(row) =>
					!after ||
					row.position > (after.position ?? 0) ||
					(row.position === after.position && BigInt(row.channelId) > BigInt(after.channelId ?? "0"))
			)
			.slice(0, input.pageSize + 1);
		const data = rows.slice(0, input.pageSize).map((row) => ({
			channelId: row.channelId,
			name: row.name,
			kind: row.isThread ? ("thread" as const) : ("channel" as const),
			parentChannelId: row.parentChannelId,
			position: row.position
		}));
		const last = data.at(-1);
		const hasNext = rows.length > data.length;
		return this.payload.bound(
			"list_channels",
			input,
			{
				data,
				pagination: {
					pageSize: input.pageSize,
					hasNext,
					nextCursor:
						hasNext && last
							? encodeCursor("list_channels", input, {
									position: last.position,
									channelId: last.channelId
								})
							: null
				}
			},
			(row) => {
				if (!("position" in row)) throw new QueryError("internal_error", "Invalid channel page");
				return { position: row.position, channelId: row.channelId };
			}
		);
	}
}
