import type {
	ChannelCreatedEvent,
	ChannelDeletedEvent,
	ChannelUpdatedEvent,
	DiscordEventConsumer,
	DiscordEventSubscription,
	GuildUpdatedEvent,
	MemberAddedEvent,
	MemberRemovedEvent,
	MemberUpdatedEvent,
	NormalizedDiscordEvent,
	ResyncNeededEvent,
	RoleCreatedEvent,
	RoleDeletedEvent,
	RoleUpdatedEvent,
	ThreadCreatedEvent,
	ThreadDeletedEvent,
	ThreadMemberAddedEvent,
	ThreadMemberRemovedEvent,
	ThreadUpdatedEvent
} from "../../discord/index.js";
import { DiscordEventKind } from "../../discord/index.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { ApplyMemberUpdateCommand } from "../commands/apply-member-update.command.js";
import type { ApplyThreadMembershipChangeCommand } from "../commands/apply-thread-membership-change.command.js";
import type { DeleteChannelCommand } from "../commands/delete-channel.command.js";
import type { DeleteRoleCommand } from "../commands/delete-role.command.js";
import type { EndMembershipCommand } from "../commands/end-membership.command.js";
import type { ResyncGuildStateCommand } from "../commands/resync-guild-state.command.js";
import type { UpsertChannelCommand } from "../commands/upsert-channel.command.js";
import type { UpsertRoleCommand } from "../commands/upsert-role.command.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { RegistryGapRecord, GuildResyncStateLedger } from "../models/domain/resync-state.js";
import { registryGapKey } from "../models/domain/resync-state.js";
import type { RegistryGuild } from "../models/domain/registry-records.js";
import type { GuildRegistryRepository } from "../repositories/guild-registry.repository.js";

/**
 * The event-subscription binding (docs/features/guild-state.md Contracts: "Event-stream subscription: the
 * `discord` feature emits normalized events; this feature subscribes to …"). It is the only place in this
 * feature that touches the normalized vocabulary: every other file takes application inputs the commands
 * already name, so a raw or transport-shaped object never enters a use case.
 *
 * What it does is deliberately thin — subscribe by kind, map field for field, hand the mapped input to the
 * committed command, report what happened:
 *
 * - **No policy of its own.** Idempotency (R9), wholesale replacement (R3, R5, R7, R10), the parent rule (R6),
 *   the deferrals (R8) and the convergence (R11) all live in the commands and in {@link ApplyGuildBootstrapCommand}
 *   behind them. Two sources of truth about one event would be the actual bug this file could introduce.
 * - **R1 asserted at the edge, not assumed.** The `discord` stream already filters to the configured Guild, but
 *   a registry that trusts its feed would scope authorization on a bug upstream. Every event whose `guildId` is
 *   not the configured one is dropped here, counted on the ledger as `foreign-guild`, and never reaches a
 *   command — so no command input can carry another Guild's id into a write.
 * - **R14 at the edge too.** The log lines name the kind, the ids, the command and the outcome. Never a name,
 *   a nickname, a message, an attachment or a credential — the fields the mapping refuses to carry are the
 *   fields no log line can leak.
 * - **Absent stays absent.** A normalized event's optional field is present only when Discord's payload carried
 *   it, so an absent `parentId` or `permissionOverwrites` is mapped as an absent command field, never as `null`
 *   or `[]`. That distinction is R10's whole content: "the update said nothing" must not become "the channel has
 *   no overwrites", and the commands only honour it if the binding does.
 *
 * The bootstrap trigger this task owns is stated by {@link handle}'s `resync-needed` case: the `discord`
 * stream publishes that signal on every transition into a connected state, including the first one
 * (docs/features/discord.md R5), so binding the signal is what makes R2's initial read happen. Nothing here
 * calls `login`, opens a socket or starts anything at construction; the composition root calls
 * {@link subscribe} when it wants events applied and {@link unsubscribe} when it does not.
 */

/** Every command this binding can reach, named so a report and a log line agree on what ran. */
export const GUILD_STATE_BOUND_COMMANDS = Object.freeze([
	"upsert-role",
	"delete-role",
	"apply-member-update",
	"end-membership",
	"upsert-channel",
	"delete-channel",
	"apply-thread-membership-change",
	"resync-guild-state",
	"upsert-guild"
] as const);

export type GuildStateBoundCommand = (typeof GUILD_STATE_BOUND_COMMANDS)[number];

/**
 * The seven event-application commands' outcomes. Every one is a discriminated application report, which is
 * what lets {@link report} decide an event's disposition from the command's own `status` instead of guessing.
 */
type GuildStateApplicationOutcome =
	| Awaited<ReturnType<UpsertRoleCommand["execute"]>>
	| Awaited<ReturnType<DeleteRoleCommand["execute"]>>
	| Awaited<ReturnType<ApplyMemberUpdateCommand["execute"]>>
	| Awaited<ReturnType<EndMembershipCommand["execute"]>>
	| Awaited<ReturnType<UpsertChannelCommand["execute"]>>
	| Awaited<ReturnType<DeleteChannelCommand["execute"]>>
	| Awaited<ReturnType<ApplyThreadMembershipChangeCommand["execute"]>>;

/**
 * The command's answer, unwrapped. `upsert-guild` carries a {@link RegistryGuild}, because the registry
 * contract's guild upsert returns the row it wrote and there is no refusal shape to report, and
 * `resync-guild-state` carries {@link ResyncGuildStateCommand}'s result, which already reports the status, the
 * gaps and the counts.
 */
export type GuildStateCommandOutcome =
	GuildStateApplicationOutcome | RegistryGuild | Awaited<ReturnType<ResyncGuildStateCommand["execute"]>>;

/** A field the event did not carry, and therefore the binding did not assert. */
export type GuildStateEventIgnoredReason =
	/** No normalized kind is bound to it: a message event, or a kind this feature has not adopted. */
	| "kind-not-bound"
	/** `GUILD_UPDATE` arrived without a name: the registry row keeps the name it has (R10). */
	| "guild-name-absent";

/**
 * What the binding did with one event. Reported rather than swallowed: `refused` and `dropped` are the
 * anomaly path's inputs (R11), and a caller that hands an event to {@link handle} directly — a composition,
 * a harness, a replay tool — gets the same answer the subscription would have produced.
 */
export type GuildStateEventDisposition =
	| {
			readonly status: "applied";
			readonly kind: DiscordEventKind;
			readonly command: GuildStateBoundCommand;
			readonly outcome: GuildStateCommandOutcome;
			/** Gaps this event left behind, recorded on the ledger and declared to the next resync (R11). */
			readonly recordedGaps: readonly RegistryGapRecord[];
			/**
			 * Set on a channel/thread event only: the bot's own viewability just turned from "cannot view" into
			 * "can view" on a text-capable channel, and the outbound port was told (S1, S3). Absent everywhere else,
			 * because a fact a command did not decide is not a fact this binding may report as `false`.
			 */
			readonly ingestibilityGained?: boolean;
	  }
	| {
			readonly status: "refused";
			readonly kind: DiscordEventKind;
			readonly command: GuildStateBoundCommand;
			readonly outcome: GuildStateCommandOutcome;
			/** The command's own reason, verbatim: never a re-wording, never a payload (R14). */
			readonly reason: string;
			readonly recordedGaps: readonly RegistryGapRecord[];
	  }
	| {
			readonly status: "dropped";
			readonly kind: DiscordEventKind;
			readonly reason: "foreign-guild";
			/** The Guild the payload named. It is an id, and naming it is what makes the drop auditable (R1). */
			readonly eventGuildId: DiscordIdentifier;
	  }
	| {
			readonly status: "ignored";
			readonly kind: DiscordEventKind;
			readonly reason: GuildStateEventIgnoredReason;
	  };

/** The report {@link subscribe} hands back: what is now listening, and how to stop. */
export interface GuildStateEventSubscriptionReport {
	readonly boundKinds: readonly DiscordEventKind[];
	readonly subscription: DiscordEventSubscription;
}

/**
 * The dependency seam. Structural command types rather than the classes, because the binding's job is the
 * mapping and a test must be able to see the mapped input exactly — with a class the recorder has to wrap
 * the class, and a wrapped class hides a changed field. Every committed command satisfies its side of this
 * interface as it stands.
 */
export interface GuildStateEventCommand<Input, Output> {
	readonly execute: (input: Input) => Promise<Output>;
}

export interface GuildStateEventSubscriptionDeps {
	readonly config: GuildStateConfig;
	readonly logger: AppLogger;
	/** The `discord` feature's stream, injected as `DISCORD_EVENT_STREAM_TOKEN` and typed as a consumer only. */
	readonly consumer: DiscordEventConsumer;
	/** R1's counter and R11's gap store: the anomaly facts a status read reports ({@link GuildResyncStateLedger}). */
	readonly ledger: GuildResyncStateLedger;
	readonly guildRegistry: GuildRegistryRepository;
	readonly upsertRole: GuildStateEventCommand<
		Parameters<UpsertRoleCommand["execute"]>[0],
		Awaited<ReturnType<UpsertRoleCommand["execute"]>>
	>;
	readonly deleteRole: GuildStateEventCommand<
		Parameters<DeleteRoleCommand["execute"]>[0],
		Awaited<ReturnType<DeleteRoleCommand["execute"]>>
	>;
	readonly applyMemberUpdate: GuildStateEventCommand<
		Parameters<ApplyMemberUpdateCommand["execute"]>[0],
		Awaited<ReturnType<ApplyMemberUpdateCommand["execute"]>>
	>;
	readonly endMembership: GuildStateEventCommand<
		Parameters<EndMembershipCommand["execute"]>[0],
		Awaited<ReturnType<EndMembershipCommand["execute"]>>
	>;
	readonly upsertChannel: GuildStateEventCommand<
		Parameters<UpsertChannelCommand["execute"]>[0],
		Awaited<ReturnType<UpsertChannelCommand["execute"]>>
	>;
	readonly deleteChannel: GuildStateEventCommand<
		Parameters<DeleteChannelCommand["execute"]>[0],
		Awaited<ReturnType<DeleteChannelCommand["execute"]>>
	>;
	readonly applyThreadMembershipChange: GuildStateEventCommand<
		Parameters<ApplyThreadMembershipChangeCommand["execute"]>[0],
		Awaited<ReturnType<ApplyThreadMembershipChangeCommand["execute"]>>
	>;
	readonly resync: GuildStateEventCommand<
		Parameters<ResyncGuildStateCommand["execute"]>[0],
		Awaited<ReturnType<ResyncGuildStateCommand["execute"]>>
	>;
}

/**
 * The kinds this binding registers, and the one it does not. Every entry is a normalized kind that exists
 * today; the list is asserted by name in `guild-state-event-subscription.test.ts`, because a kind added to
 * the `discord` vocabulary must be *decided* here rather than silently unbound or silently applied.
 *
 * Deliberately absent, with the reason:
 *
 * - **`ban-added` / `ban-removed`** — not bound because not published: those kinds are conditional in
 *   `docs/features/discord.md` (kept out of `DiscordEventKind` until guild-state adopts them, open decision
 *   O3), so there is no handler to register. R4's effect is already covered: a ban also arrives as
 *   `member-removed`, which ends the Membership and its dependents, and a ban taken during downtime is
 *   covered by the resync's fresh roster. When those kinds are published, `ban-added` maps onto
 *   {@link EndMembershipCommand} and `ban-removed` maps onto nothing (the registry does not store a ban),
 *   which is the whole of the future change.
 * - **`message-created` / `-updated` / `-deleted` / `message-bulk-delete`** — ingestion's business, not the
 *   registry's. They are never subscribed, so no message content can enter this feature's commands or logs.
 * - **`guild-deleted`** — the kind does not exist in the normalized vocabulary, so R1's boundary ("a configured
 *   Guild that is deleted makes the registry `unavailable`") is not reachable from the event path. The registry
 *   reaches `unavailable` through the REST read instead: a 4xx on the Guild read during bootstrap or resync
 *   marks the ledger unavailable (T2, T8). This is the documented gap, and the reason the status query exists.
 */
export const GUILD_STATE_BOUND_EVENT_KINDS = Object.freeze([
	DiscordEventKind.guildUpdated,
	DiscordEventKind.roleCreated,
	DiscordEventKind.roleUpdated,
	DiscordEventKind.roleDeleted,
	DiscordEventKind.memberAdded,
	DiscordEventKind.memberUpdated,
	DiscordEventKind.memberRemoved,
	DiscordEventKind.channelCreated,
	DiscordEventKind.channelUpdated,
	DiscordEventKind.channelDeleted,
	DiscordEventKind.threadCreated,
	DiscordEventKind.threadUpdated,
	DiscordEventKind.threadDeleted,
	DiscordEventKind.threadMemberAdded,
	DiscordEventKind.threadMemberRemoved,
	DiscordEventKind.resyncNeeded
] as const satisfies readonly DiscordEventKind[]);

export class GuildStateEventSubscription {
	private readonly guildId: DiscordIdentifier;

	private readonly logger: AppLogger;

	private readonly consumer: DiscordEventConsumer;

	private readonly ledger: GuildResyncStateLedger;

	private readonly guildRegistry: GuildRegistryRepository;

	private readonly upsertRole: GuildStateEventSubscriptionDeps["upsertRole"];

	private readonly deleteRole: GuildStateEventSubscriptionDeps["deleteRole"];

	private readonly applyMemberUpdate: GuildStateEventSubscriptionDeps["applyMemberUpdate"];

	private readonly endMembership: GuildStateEventSubscriptionDeps["endMembership"];

	private readonly upsertChannel: GuildStateEventSubscriptionDeps["upsertChannel"];

	private readonly deleteChannel: GuildStateEventSubscriptionDeps["deleteChannel"];

	private readonly applyThreadMembershipChange: GuildStateEventSubscriptionDeps["applyThreadMembershipChange"];

	private readonly resync: GuildStateEventSubscriptionDeps["resync"];

	private subscription: DiscordEventSubscription | null = null;

	/**
	 * The anomaly reports the event path produced, keyed by {@link registryGapKey} so a replayed delivery is
	 * one report and not two (R9). They are handed to the next resync as its {@link ResyncGuildStateInput}
	 * gaps, which is the seam T8 built for them, and an entry is removed only when a run proves it closed.
	 */
	private readonly pendingGaps = new Map<string, RegistryGapRecord>();

	public constructor(deps: GuildStateEventSubscriptionDeps) {
		this.guildId = deps.config.guildId;
		this.logger = deps.logger;
		this.consumer = deps.consumer;
		this.ledger = deps.ledger;
		this.guildRegistry = deps.guildRegistry;
		this.upsertRole = deps.upsertRole;
		this.deleteRole = deps.deleteRole;
		this.applyMemberUpdate = deps.applyMemberUpdate;
		this.endMembership = deps.endMembership;
		this.upsertChannel = deps.upsertChannel;
		this.deleteChannel = deps.deleteChannel;
		this.applyThreadMembershipChange = deps.applyThreadMembershipChange;
		this.resync = deps.resync;
	}

	/** True while handlers are registered. The subscription is one, and it is idempotent. */
	public get isSubscribed(): boolean {
		return this.subscription !== null;
	}

	/**
	 * Registers one handler per bound kind. Called by the composition root, never by the module: this feature
	 * starts nothing on its own (docs/features/guild-state.md Contracts; `guild-state.module.ts`).
	 *
	 * A second call while subscribed returns the same report instead of registering a second set, because two
	 * handlers of one kind would apply one event twice — idempotent writes (R9) aside, that is two resyncs and
	 * two anomaly counts for one delivery.
	 */
	public readonly subscribe = (): GuildStateEventSubscriptionReport => {
		if (this.subscription !== null) {
			this.logger.debug("guild-state event subscription already active", {
				guildId: this.guildId,
				boundKindCount: GUILD_STATE_BOUND_EVENT_KINDS.length
			});
			return { boundKinds: [...GUILD_STATE_BOUND_EVENT_KINDS], subscription: this.subscription };
		}

		// Registration order is delivery order in the stream, so the sequence here is a decision only about
		// a same-kind fan-out this feature does not have. Each kind gets the one handler its command needs.
		const registrations = GUILD_STATE_BOUND_EVENT_KINDS.map((kind) =>
			this.consumer.subscribe(kind, async (event) => {
				await this.handle(event);
			})
		);
		const subscription: DiscordEventSubscription = {
			unsubscribe: () => {
				for (const registration of registrations) {
					registration.unsubscribe();
				}
				this.subscription = null;
				this.logger.info("guild-state event subscription stopped", {
					guildId: this.guildId,
					unsubscribedKindCount: registrations.length
				});
			}
		};
		this.subscription = subscription;
		this.logger.info("guild-state event subscription started", {
			guildId: this.guildId,
			boundKindCount: registrations.length
		});
		return { boundKinds: [...GUILD_STATE_BOUND_EVENT_KINDS], subscription };
	};

	/** Stops listening. Idempotent, and never drops a gap report: pending anomalies stay on the ledger. */
	public readonly unsubscribe = (): void => {
		this.subscription?.unsubscribe();
		this.subscription = null;
	};

	/**
	 * One normalized event, applied. Public because the subscription and a direct call must be the same code
	 * path: a harness, a replay or a composition that prefers to hand events over drives this and sees the
	 * same {@link GuildStateEventDisposition} the registered handler produced.
	 *
	 * A command that throws is not caught here. An id the registry cannot store is a malformed payload, and
	 * `requireDiscordIdentifier` already names that decision for every command (T3–T6); the stream contains a
	 * failing handler, counts the delivery failure and declares the gap, which turns the failure into a
	 * resync rather than a hole (docs/features/discord.md R4). Swallowing it into a `refused` disposition
	 * would hide the one anomaly the resync path needs to see.
	 */
	public async handle(event: NormalizedDiscordEvent): Promise<GuildStateEventDisposition> {
		// R1, at the edge: the stream filters, and this does not depend on it. A payload about another Guild
		// is dropped and counted before any command can turn it into a write.
		if (event.guildId !== this.guildId) {
			return this.dropForeign(event);
		}

		switch (event.kind) {
			case DiscordEventKind.roleCreated:
			case DiscordEventKind.roleUpdated:
				return this.applyRole(event);
			case DiscordEventKind.roleDeleted:
				return this.applyRoleDeletion(event);
			case DiscordEventKind.memberAdded:
			case DiscordEventKind.memberUpdated:
				return this.applyMemberUpdateEvent(event);
			case DiscordEventKind.memberRemoved:
				return this.applyMembershipEnd(event);
			case DiscordEventKind.channelCreated:
			case DiscordEventKind.channelUpdated:
				return this.applyChannel(event);
			case DiscordEventKind.threadCreated:
			case DiscordEventKind.threadUpdated:
				return this.applyThread(event);
			case DiscordEventKind.channelDeleted:
				return this.applyChannelDeletion(event);
			case DiscordEventKind.threadDeleted:
				return this.applyThreadDeletion(event);
			case DiscordEventKind.threadMemberAdded:
				return this.applyThreadMembership(event, "added");
			case DiscordEventKind.threadMemberRemoved:
				return this.applyThreadMembership(event, "removed");
			case DiscordEventKind.resyncNeeded:
				return this.applyResyncSignal(event);
			case DiscordEventKind.guildUpdated:
				return this.applyGuildUpdate(event);
			case DiscordEventKind.messageCreated:
			case DiscordEventKind.messageUpdated:
			case DiscordEventKind.messageDeleted:
			case DiscordEventKind.messageBulkDeleted:
				// Never registered by `subscribe`; reachable only through a direct call. Unbound, and reported
				// as such rather than applied or ignored silently.
				return this.ignore(event.kind, "kind-not-bound");
		}
	}

	/* ------------------------------------------------------------------------------ role (R3) */

	/**
	 * `role-created` / `role-updated` → `UpsertRoleCommand`, field for field. A name or bitfield the payload did
	 * not carry is absent in the command input too, which is what lets T3's rule decide between "complete from
	 * stored state" and "refuse" instead of reading an invented empty string (R3 error case, R10).
	 */
	private async applyRole(event: RoleCreatedEvent | RoleUpdatedEvent): Promise<GuildStateEventDisposition> {
		const outcome = await this.upsertRole.execute({
			guildId: event.guildId,
			roleId: event.roleId,
			...(event.roleName === undefined ? {} : { roleName: event.roleName }),
			...(event.permissionsBitfield === undefined ? {} : { permissionsBitfield: event.permissionsBitfield })
		});
		const gaps =
			outcome.status === "refused"
				? [
						this.recordGap({
							kind: "role-incomplete-description",
							resourceId: outcome.roleId,
							reason: outcome.reason,
							pendingFields: outcome.missingFields
						})
					]
				: [];
		return this.report(event, "upsert-role", outcome, gaps);
	}

	/** `role-deleted` → `DeleteRoleCommand`. The cascade is the repository's transaction, not this file's problem. */
	private async applyRoleDeletion(event: RoleDeletedEvent): Promise<GuildStateEventDisposition> {
		const outcome = await this.deleteRole.execute({ guildId: event.guildId, roleId: event.roleId });
		return this.report(event, "delete-role", outcome, []);
	}

	/* --------------------------------------------------------------------------- membership (R4, R5) */

	/**
	 * `member-added` / `member-updated` → `ApplyMemberUpdateCommand`. Only the id and the complete role set are
	 * mapped: the payload's `nickname`, `joinedInstant` and `isPending` are deliberately not carried, because the
	 * registry stores none of them (R14, open decision O2) and a field the registry does not hold must not reach
	 * a command — or a log line — through the binding that could have passed it on.
	 */
	private async applyMemberUpdateEvent(
		event: MemberAddedEvent | MemberUpdatedEvent
	): Promise<GuildStateEventDisposition> {
		const outcome = await this.applyMemberUpdate.execute({
			guildId: event.guildId,
			userId: event.userId,
			roleIds: event.roleIds
		});
		// R5's error case at the foreign key: a set naming an id the registry does not hold keeps the known
		// part and reports the rest. Each deferred id is a gap a fresh role list plus a fresh roster closes (T8).
		const gaps =
			outcome.status === "applied"
				? outcome.deferredRoleIds.map((roleId) =>
						this.recordGap({
							kind: "role-id-deferred",
							resourceId: roleId,
							reason: "role-id-deferred"
						})
					)
				: [];
		return this.report(event, "apply-member-update", outcome, gaps);
	}

	/** `member-removed` → `EndMembershipCommand`: leave, kick and ban are one fact to authorization (R4). */
	private async applyMembershipEnd(event: MemberRemovedEvent): Promise<GuildStateEventDisposition> {
		const outcome = await this.endMembership.execute({ guildId: event.guildId, userId: event.userId });
		return this.report(event, "end-membership", outcome, []);
	}

	/* ------------------------------------------------------------------------ channels and threads (R6, R7, R8) */

	/**
	 * `channel-created` / `channel-updated` → `UpsertChannelCommand`. `parentId` maps onto `parentChannelId`
	 * and `permissionOverwrites` onto `permissionOverwrites`; each is spread only when present. An absent
	 * parent must not become `null` (that is the payload *naming no parent*, which R6 lets a non-thread store
	 * and forbids a thread from being), and an absent overwrite list must not become `[]` (that is R7's
	 * wholesale replacement of a set Discord never said was empty).
	 */
	private async applyChannel(event: ChannelCreatedEvent | ChannelUpdatedEvent): Promise<GuildStateEventDisposition> {
		const outcome = await this.upsertChannel.execute({
			guildId: event.guildId,
			channelId: event.channelId,
			channelType: event.channelType,
			...(event.name === undefined ? {} : { name: event.name }),
			...(event.parentId === undefined ? {} : { parentChannelId: event.parentId }),
			...(event.permissionOverwrites === undefined ? {} : { permissionOverwrites: event.permissionOverwrites })
		});
		return this.reportChannel(event, outcome);
	}

	/**
	 * `thread-created` / `thread-updated` → the same `UpsertChannelCommand`: a thread is a channel with a
	 * parent (R6), and thread-ness is derived from the channel type inside the command, never declared here.
	 *
	 * Two payload fields are consciously not mapped. `archived` has no registry column and no evaluation rule,
	 * so storing it would be a field nothing reads (R13's registry holds what authorization consumes).
	 * `memberIds` — the initial member list a private-thread creation carries — is not applied either: R8 makes
	 * an edge a `thread-member-added` fact, and T8 leaves private-thread membership to the REST reconciliation
	 * that open decision O1 bounds. The create payload is not that read, and inventing edges from it would be
	 * the failure mode O1 names.
	 */
	private async applyThread(event: ThreadCreatedEvent | ThreadUpdatedEvent): Promise<GuildStateEventDisposition> {
		const outcome = await this.upsertChannel.execute({
			guildId: event.guildId,
			channelId: event.threadId,
			channelType: event.threadType,
			...(event.name === undefined ? {} : { name: event.name }),
			...(event.parentChannelId === undefined ? {} : { parentChannelId: event.parentChannelId })
		});
		return this.reportChannel(event, outcome);
	}

	/**
	 * One channel or thread outcome, reported. `pendingRestFields` carrying `permissionOverwrites` is R10's
	 * absent-is-not-empty gap, declared for the resync's targeted channel read; a refusal for a thread with no
	 * resolvable parent (R6) is reported and left un-gapped, because the gap vocabulary has no kind for it and
	 * T5's own answer is that the corrected event — not an invented read — is what applies later.
	 *
	 * The access trigger's outcome is reported alongside, as the command decided it (S3): a caller that handed
	 * this binding an event sees the same `ingestibilityGained` the subscription's own handler would have seen.
	 * The binding does not re-evaluate anything — a second opinion about one permission decision is the defect
	 * this feature exists to prevent — and a refusal, which stored nothing, carries no channel facts at all.
	 */
	private reportChannel(
		event: ChannelCreatedEvent | ChannelUpdatedEvent | ThreadCreatedEvent | ThreadUpdatedEvent,
		outcome: Awaited<ReturnType<UpsertChannelCommand["execute"]>>
	): GuildStateEventDisposition {
		const gaps: RegistryGapRecord[] = [];
		if (outcome.status === "applied" && outcome.pendingRestFields.includes("permissionOverwrites")) {
			gaps.push(
				this.recordGap({
					kind: "channel-pending-rest-fields",
					resourceId: outcome.channelId,
					reason: "payload-carried-no-overwrite-set",
					pendingFields: outcome.pendingRestFields
				})
			);
		}
		const disposition = this.report(event, "upsert-channel", outcome, gaps);
		if (disposition.status !== "applied" || outcome.status !== "applied") {
			return disposition;
		}
		return { ...disposition, ingestibilityGained: outcome.ingestibilityGained };
	}

	/** `channel-deleted` → `DeleteChannelCommand`, with the overwrite and thread-membership cascade (R6, R9). */
	private async applyChannelDeletion(event: ChannelDeletedEvent): Promise<GuildStateEventDisposition> {
		const outcome = await this.deleteChannel.execute({ guildId: event.guildId, channelId: event.channelId });
		return this.report(event, "delete-channel", outcome, []);
	}

	/** `thread-deleted` → the same deletion command: one registry, one cascade (R6). */
	private async applyThreadDeletion(event: ThreadDeletedEvent): Promise<GuildStateEventDisposition> {
		const outcome = await this.deleteChannel.execute({ guildId: event.guildId, channelId: event.threadId });
		return this.report(event, "delete-channel", outcome, []);
	}

	/**
	 * `thread-member-added` / `thread-member-removed` → one `ApplyThreadMembershipChangeCommand` whose `change`
	 * is the direction the kind names. The mapping is by kind rather than by any payload field, because the
	 * normalized event carries no direction flag: `kind` *is* the fact, and getting it backwards would turn a
	 * revocation into a grant.
	 *
	 * R8's error case is a gap: a thread the registry does not hold yet keeps the change deferred and declares
	 * `thread-membership-unobserved`, which T8 deliberately never closes optimistically (O1).
	 */
	private async applyThreadMembership(
		event: ThreadMemberAddedEvent | ThreadMemberRemovedEvent,
		change: "added" | "removed"
	): Promise<GuildStateEventDisposition> {
		const outcome = await this.applyThreadMembershipChange.execute({
			guildId: event.guildId,
			threadId: event.threadId,
			userId: event.userId,
			change
		});
		const gaps =
			outcome.status === "refused" && outcome.reason === "unknown-thread"
				? [
						this.recordGap({
							kind: "thread-membership-unobserved",
							resourceId: outcome.threadId,
							reason: outcome.reason
						})
					]
				: [];
		return this.report(event, "apply-thread-membership-change", outcome, gaps);
	}

	/* --------------------------------------------------------------------------------- guild (R1) */

	/**
	 * `guild-updated` → the registry's guild upsert.
	 *
	 * **The gap this documents.** The committed command surface has no event-shaped guild upsert: Contracts
	 * names `ApplyGuildBootstrapCommand` for the Guild row, and that is a whole REST pass, not the answer to a
	 * rename. The row's only other writer is `GuildRegistryRepository.upsertGuild` — the repository contract
	 * Contracts itself lists ("upsert Guild") — so this binding is the seam that calls it, and it is the one
	 * place in this feature that writes through a repository contract instead of a command. Adding
	 * `UpsertGuildCommand` would move this write behind the usual boundary; that is a Contracts change, not a
	 * binding decision, so it is recorded here rather than made silently.
	 *
	 * A payload that named no name writes nothing: the registry keeps the name it has (R10), and an absent
	 * field never becomes an empty string. `ownerId` and `memberCount` are not stored at all — the `guild`
	 * table carries id and name only, and neither number is an input to authorization.
	 */
	private async applyGuildUpdate(event: GuildUpdatedEvent): Promise<GuildStateEventDisposition> {
		if (event.guildName === undefined) {
			return this.ignore(event.kind, "guild-name-absent");
		}

		// Always the configured id, never `event.guildId` unexamined: R1 has already proved they are equal, and
		// writing the configured one keeps the single-Guild index unable to be violated by a payload.
		const guild = await this.guildRegistry.upsertGuild({ guildId: this.guildId, guildName: event.guildName });
		this.logger.debug("guild-state applied a guild event through the guild registry", {
			guildId: this.guildId,
			kind: event.kind,
			command: "upsert-guild"
		});
		return { status: "applied", kind: event.kind, command: "upsert-guild", outcome: guild, recordedGaps: [] };
	}

	/* --------------------------------------------------------------------------------- resync (R11) */

	/**
	 * `resync-needed` → `ResyncGuildStateCommand`, and with it R2's first read: the `discord` stream publishes
	 * this signal on every transition into a connected state, the first connection included
	 * (docs/features/discord.md R5), so a process that binds the stream converges a cold registry through the
	 * same path a reconnect does. That is this task's answer to "when does a bootstrap run, and on what trigger".
	 *
	 * The epoch is the signal's, which is what makes a replayed signal inert (R9). `reason` is the signal's own
	 * name, not a guessed cause: the stream says a gap ended in a connected state, and does not say whether the
	 * gap was a reconnect, a dropped delivery or a drain expiry. `affectedKinds` is mapped only when present —
	 * absent is R5's whole-connection gap, and T8 records it as a fact without letting it narrow the pass.
	 * `lastDeliveredInstant` and `reconnectAttempts` are not inputs to the command and are not stored; they are
	 * observability the `discord` feature reports, and inventing a field to carry them here would be a second
	 * source of truth about one gap.
	 */
	private async applyResyncSignal(event: ResyncNeededEvent): Promise<GuildStateEventDisposition> {
		const declared = [...this.pendingGaps.values()];
		const outcome = await this.resync.execute({
			epoch: event.epoch,
			guildId: event.guildId,
			reason: event.kind,
			...(event.affectedKinds === undefined ? {} : { affectedKinds: event.affectedKinds }),
			gaps: declared
		});

		// A gap a run proved closed stops being declared; one it could not close stays, so the next signal
		// retries it. The ledger keeps both facts either way — this map is only the resync's input list (R11).
		for (const gap of outcome.resolvedGaps) {
			this.pendingGaps.delete(registryGapKey(gap));
		}

		return {
			status: "applied",
			kind: event.kind,
			command: "resync-guild-state",
			outcome,
			recordedGaps: []
		};
	}

	/* ------------------------------------------------------------------------------ reporting */

	/** R1 at the edge: counted, logged by kind and id, and no command is reached. */
	private dropForeign(event: NormalizedDiscordEvent): GuildStateEventDisposition {
		this.ledger.countAnomaly("foreign-guild");
		this.logger.warn("guild-state dropped an event for another guild at the subscription boundary", {
			guildId: this.guildId,
			eventGuildId: event.guildId,
			kind: event.kind,
			operation: "event-subscription"
		});
		return { status: "dropped", kind: event.kind, reason: "foreign-guild", eventGuildId: event.guildId };
	}

	private ignore(kind: DiscordEventKind, reason: GuildStateEventIgnoredReason): GuildStateEventDisposition {
		this.logger.debug("guild-state left a bound event unapplied", { guildId: this.guildId, kind, reason });
		return { status: "ignored", kind, reason };
	}

	/**
	 * One anomaly report, recorded once. The ledger holds the status fact (R11: a gap keeps the registry
	 * `stale` until a read proves otherwise) and the binding's own map holds the declaration for the next
	 * resync. Keyed by kind and resource, so a redelivery cannot inflate either one (R9).
	 */
	private recordGap(gap: RegistryGapRecord): RegistryGapRecord {
		this.ledger.recordGap(gap);
		this.pendingGaps.set(registryGapKey(gap), gap);
		return gap;
	}

	/**
	 * The command's own outcome, reported as what it was. A `dropped` outcome can only mean the command saw a
	 * foreign id the edge had already rejected, so it is passed through unchanged rather than rewritten — the
	 * count is the ledger's, not a second tally here.
	 */
	private report(
		event: NormalizedDiscordEvent,
		command: GuildStateBoundCommand,
		outcome: GuildStateApplicationOutcome,
		recordedGaps: readonly RegistryGapRecord[]
	): GuildStateEventDisposition {
		const kind = event.kind;
		switch (outcome.status) {
			case "dropped":
				// Unreachable through `handle`, which refuses a foreign id before any command sees it, and named
				// here anyway: the command's own R1 drop is the same fact from the other side, and the payload's
				// Guild id is the one worth auditing.
				return {
					status: "dropped",
					kind,
					reason: "foreign-guild",
					eventGuildId: event.guildId
				};
			case "refused": {
				const reason = outcome.reason;
				this.logger.warn("guild-state event command refused a normalized event", {
					guildId: this.guildId,
					kind,
					command,
					reason,
					recordedGapCount: recordedGaps.length
				});
				return { status: "refused", kind, command, outcome, reason, recordedGaps };
			}
			case "applied":
				this.logger.debug("guild-state applied a normalized event", {
					guildId: this.guildId,
					kind,
					command,
					recordedGapCount: recordedGaps.length
				});
				return { status: "applied", kind, command, outcome, recordedGaps };
		}
	}
}
