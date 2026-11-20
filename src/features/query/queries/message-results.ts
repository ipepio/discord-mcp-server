import type { StoredMessage } from "../models/domain/message.js";
import { QueryError } from "../models/domain/query.errors.js";
import type { MessageResult } from "../models/domain/tool-result.js";
import type { QueryAccess } from "./query-access.policy.js";

export function messageResults(rows: readonly StoredMessage[], access: QueryAccess): MessageResult[] {
	const channels = new Map(access.channels.map((channel) => [channel.channelId, channel]));
	return rows.map((row) => {
		const channel = channels.get(row.channelId);
		if (!channel || row.guildId !== access.guildId) throw new QueryError("internal_error", "Invalid message scope");
		return { ...row, channelName: channel.name, parentChannelId: channel.parentChannelId, truncated: false };
	});
}
export async function readMessages<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof QueryError) throw error;
		throw new QueryError("internal_error", "Could not read messages");
	}
}
