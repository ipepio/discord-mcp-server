import { DiscordEventKind } from "../../discord/index.js";
import type { DiscordEventConsumer, DiscordEventSubscription } from "../../discord/index.js";
import type { RevokeUserSessionsCommand } from "../commands/revoke-user-sessions.command.js";

/** Only normalized membership-end events; ban kinds are conditional and absent from the current stream. */
export class MembershipEndSubscription {
	private subscription: DiscordEventSubscription | undefined;
	public constructor(
		private readonly deps: {
			readonly events: DiscordEventConsumer;
			readonly revoke: RevokeUserSessionsCommand;
			readonly guildId: string;
		}
	) {}
	public readonly onModuleInit = (): void => {
		if (this.subscription) return;
		this.subscription = this.deps.events.subscribe(DiscordEventKind.memberRemoved, async (event) => {
			if (event.guildId !== this.deps.guildId) return;
			// The command counts and logs failures. Await propagation so the stream also observes the failed delivery.
			await this.deps.revoke.execute(event.userId);
		});
	};
	public readonly onModuleDestroy = (): void => {
		this.subscription?.unsubscribe();
		this.subscription = undefined;
	};
}
