import type {
	DiscordChannelRecord,
	DiscordGuildSnapshot,
	DiscordMemberRoster,
	DiscordRoleRecord,
	DiscordThreadMemberPage,
	MemberRosterRead,
	ThreadMemberRead
} from "../../discord/index.js";

/**
 * The guild-state gateway contract (docs/features/guild-state.md, Contracts: "REST guild-state reads (Guild,
 * roles, channels with overwrites, paginated members, and thread-member reconciliation where available) sit
 * behind a narrow `GuildStateGateway` contract owned here").
 *
 * The contract is declared here, in the feature that consumes it, and the discord.js call sites stay in the
 * `discord` feature's REST adapter — which satisfies this shape structurally, exactly as that feature's own
 * note on `DiscordGuildStateRestOperations` anticipates. The import direction is type-only and one-way:
 * `guild-state` knows these application types, `discord` knows nothing about this feature
 * (docs/architecture/structure.md).
 *
 * Two absences are the point. There is no guild id on any read, because the adapter is constructed with the
 * configured Guild and R1 must not be negotiable per call; and there is no write, because the hub mirrors
 * permission state and never changes it. Rate limits, bounded retries with backoff, timeouts, pagination
 * bounds and payload validation live inside the adapter (docs/features/discord.md R7), so a caller here gets
 * either an application-typed result or a named `DiscordRestFailureError` — never a partially populated
 * result to interpret.
 */
export interface GuildStateGateway {
	/** The configured Guild row: id and name (R2). */
	readonly readGuildSnapshot: () => Promise<DiscordGuildSnapshot>;

	/** The whole role list, @everyone included, with bitfields as Discord encodes them (R2, R3). */
	readonly readRoles: () => Promise<readonly DiscordRoleRecord[]>;

	/** Channels and threads, each carrying its overwrite set when the object sent one (R2, R6, R7). */
	readonly readChannels: () => Promise<readonly DiscordChannelRecord[]>;

	/** The paginated member roster, bounded by the read request and by the adapter's own policy (R2). */
	readonly readMemberRoster: (read?: MemberRosterRead) => Promise<DiscordMemberRoster>;

	/** One bounded thread-member page, where the API allows this Installation that read (R8, O1). */
	readonly readThreadMembers: (read: ThreadMemberRead) => Promise<DiscordThreadMemberPage>;
}
