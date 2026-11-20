import type { GetGuildIdentityQuery, GuildRegistryStatus } from "../../guild-state/index.js";
import type { QueryAccessPolicy, RegistryStatusReader } from "./query-access.policy.js";
import { readBotViewableChannelIds } from "./bot-access.js";
import type { BotViewableChannelsReader } from "./bot-access.js";
import type { ToolInput } from "../models/domain/tool-input.js";
import type { HubStatusResult } from "../models/domain/tool-result.js";
import { QueryError } from "../models/domain/query.errors.js";

/**
 * `get_hub_status` (R17, owner decision "3 · Tool de estado", 2026-11-12): one call answers "is this hub
 * healthy, and is this count the truth?" with the Guild it serves, the registry's own freshness status and
 * the size of R12's intersection — exactly what the caller could obtain by paging `list_channels` to
 * exhaustion (docs/features/query.md R17).
 *
 * It is the ONE query tool R11 does not gate: its answer *is* the status, so a `stale`, `incomplete` or
 * `unavailable` registry is reported instead of refused, and while the status is not current this use case
 * reads no channel list at all — a count computed from state the hub cannot attest would be a claim, not a
 * fact (O12). The count itself comes from the same consumed contracts every other tool uses: the Requester's
 * viewable entries through the access policy and the bot's viewable entries through the bot-access seam, with
 * the bot's User id supplied by composition, never by a tool argument (R1).
 *
 * Nothing per-container leaves this use case: the answer carries no channel id, no channel name, no parent
 * id, no message and no byte of content, so it cannot confirm the existence of a container `list_channels`
 * would not list (R3). No SQL and no registry table read lives here either (R9).
 */
export class GetHubStatusQuery {
	public constructor(
		private readonly status: RegistryStatusReader,
		private readonly identity: Pick<GetGuildIdentityQuery, "execute">,
		private readonly access: QueryAccessPolicy,
		private readonly bot: BotViewableChannelsReader,
		private readonly botUserId: string
	) {}
	public async execute(input: ToolInput & { readonly userId: string }): Promise<HubStatusResult> {
		const current = await this.readStatus();
		const guild = await this.readGuild(current);
		if (current.status !== "current")
			return {
				guild,
				registry: { status: current.status },
				mirror: { visibleAndMirroredChannelCount: null }
			};
		const access = await this.access.evaluate(input.userId, "visibility", current.guildId);
		const botViewable = await readBotViewableChannelIds(this.bot, this.botUserId);
		return {
			guild,
			registry: { status: current.status },
			mirror: {
				visibleAndMirroredChannelCount: access.channels.filter((row) => botViewable.has(row.channelId)).length
			}
		};
	}
	/** R17's error case: a status read it cannot complete is `internal_error`, never `state_unavailable`. */
	private async readStatus(): Promise<{ readonly status: GuildRegistryStatus; readonly guildId: string }> {
		try {
			const current = await this.status.execute();
			return { status: current.status, guildId: current.guildId };
		} catch {
			throw new QueryError("internal_error", "Could not read the registry status");
		}
	}
	/**
	 * R8's identity read, reused: the registry can attest its own Guild while it is current or stale, and
	 * while it is `incomplete`/`unavailable` the identity is unknown. O11's resolution widens the declared
	 * shape to `null` in that case and while the registry holds no Guild row — never a placeholder string and
	 * never the configured Guild id, which would claim an identity nothing stored.
	 */
	private async readGuild(current: {
		readonly status: GuildRegistryStatus;
		readonly guildId: string;
	}): Promise<{ readonly name: string | null; readonly id: string | null }> {
		if (current.status !== "current" && current.status !== "stale") return { name: null, id: null };
		try {
			const identity = await this.identity.execute();
			if (identity.status === "registered" && identity.guild.guildId === current.guildId)
				return { name: identity.guild.guildName, id: identity.guild.guildId };
			return { name: null, id: null };
		} catch {
			// R8's non-blocking identity read: an identity that cannot be read is reported as unattested, not
			// as a fabricated name and not as a failed status; the status and count halves stay truthful.
			return { name: null, id: null };
		}
	}
}
