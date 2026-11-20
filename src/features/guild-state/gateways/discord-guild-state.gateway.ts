import type { DiscordGuildStateRestOperations } from "../../discord/index.js";
import type { GuildStateGateway } from "./guild-state-gateway.interface.js";

/**
 * The `GuildStateGateway` implementation, which delegates every read to the `discord` feature's REST
 * operations (docs/features/guild-state.md, Contracts: the guild-state reads "sit behind a narrow
 * `GuildStateGateway` contract owned here; the discord.js call sites live in the Discord gateway adapter").
 *
 * So this file adds a name, not a behaviour. No retry, no backoff, no timeout, no pagination loop and no
 * validation appears here: all of that is the adapter's R7 promise, and duplicating it would create two
 * competing retry budgets against one rate-limit window. The adapter already carries the configured Guild,
 * so nothing here can point a read at another one (R1).
 *
 * The dependency is the read contract only (`DiscordGuildStateRestOperations`), a type-only import of the
 * `discord` feature's public surface — the message-history read that same barrel exports is deliberately not
 * reachable through this gateway, so a guild-state use case cannot acquire it.
 */
export class DiscordGuildStateGateway implements GuildStateGateway {
	public constructor(private readonly deps: { readonly rest: DiscordGuildStateRestOperations }) {}

	public readonly readGuildSnapshot = () => this.deps.rest.readGuildSnapshot();

	public readonly readRoles = () => this.deps.rest.readRoles();

	public readonly readChannels = () => this.deps.rest.readChannels();

	public readonly readMemberRoster = (read?: Parameters<GuildStateGateway["readMemberRoster"]>[0]) =>
		this.deps.rest.readMemberRoster(read);

	public readonly readThreadMembers = (read: Parameters<GuildStateGateway["readThreadMembers"]>[0]) =>
		this.deps.rest.readThreadMembers(read);
}
