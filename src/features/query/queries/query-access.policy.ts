import type {
	GetGuildStateStatusQuery,
	ListUserAccessibleChannelsQuery,
	UserAccessibleChannelEntry
} from "../../guild-state/index.js";
import { QueryError } from "../models/domain/query.errors.js";

/** Additive guild-state identity seam approved by the coordinator; reconciled at merge. */
export interface QueryChannel extends UserAccessibleChannelEntry {
	readonly name: string;
	readonly position: number;
}
export interface RegistryAccessReader {
	readonly execute: (input: Parameters<ListUserAccessibleChannelsQuery["execute"]>[0]) => Promise<{
		readonly guildId: string;
		readonly channels: readonly QueryChannel[];
	}>;
}
export interface RegistryStatusReader {
	readonly execute: () => Promise<
		Pick<Awaited<ReturnType<GetGuildStateStatusQuery["execute"]>>, "status" | "guildId">
	>;
}
export interface QueryAccess {
	readonly guildId: string;
	readonly channels: readonly QueryChannel[];
	readonly accessibleChannelIds: readonly string[];
}
/** The list query performs the same effective-permission evaluation in ONE registry snapshot.
 * No per-channel evaluation loop, local bitfield derivation, cache or client-supplied ACL exists here.
 */
export class QueryAccessPolicy {
	public constructor(
		private readonly status: RegistryStatusReader,
		private readonly registry: RegistryAccessReader
	) {}
	public async resolve(userId: string, gate: "visibility" | "content"): Promise<QueryAccess> {
		let current;
		try {
			current = await this.status.execute();
		} catch {
			throw new QueryError("state_unavailable", "Registry status unavailable; retry later");
		}
		if (current.status !== "current")
			throw new QueryError("state_unavailable", `Registry ${current.status}; retry later`);
		return this.evaluate(userId, gate, current.guildId);
	}
	/**
	 * The same evaluation without R11's gate, for `get_hub_status` (R17): that tool's answer *is* the status,
	 * so it reads the status once itself and, only when it is current, asks for the evaluated set. Splitting
	 * the gate from the evaluation keeps one implementation of "which entries may this Requester see" and
	 * avoids a second status read inside a single request (R11's boundary).
	 */
	public async evaluate(userId: string, gate: "visibility" | "content", guildId: string): Promise<QueryAccess> {
		try {
			const result = await this.registry.execute({ userId });
			if (result.guildId !== guildId) throw new Error("Registry guild mismatch");
			const channels = result.channels.filter(
				(channel) => gate === "visibility" || channel.canReadMessageHistory
			);
			return {
				guildId: result.guildId,
				channels,
				accessibleChannelIds: channels.map((channel) => channel.channelId)
			};
		} catch {
			throw new QueryError("internal_error", "Could not evaluate permissions");
		}
	}
}
