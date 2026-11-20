import { describe, expect, it } from "vitest";
import type {
	ChannelCreatedEvent,
	ChannelDeletedEvent,
	ChannelUpdatedEvent,
	DiscordEventKind,
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
} from "../../../src/features/discord/index.js";
import { DiscordEventKind as Kind, DISCORD_EVENT_KINDS } from "../../../src/features/discord/index.js";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import { InMemoryGuildResyncLedger } from "../../../src/features/guild-state/bootstrap/in-memory-resync-ledger.js";
import { ApplyGuildBootstrapCommand } from "../../../src/features/guild-state/commands/apply-guild-bootstrap.command.js";
import { ApplyMemberUpdateCommand } from "../../../src/features/guild-state/commands/apply-member-update.command.js";
import { ApplyThreadMembershipChangeCommand } from "../../../src/features/guild-state/commands/apply-thread-membership-change.command.js";
import { DeleteChannelCommand } from "../../../src/features/guild-state/commands/delete-channel.command.js";
import { DeleteRoleCommand } from "../../../src/features/guild-state/commands/delete-role.command.js";
import { EndMembershipCommand } from "../../../src/features/guild-state/commands/end-membership.command.js";
import { ResyncGuildStateCommand } from "../../../src/features/guild-state/commands/resync-guild-state.command.js";
import { SweepVanishedStateCommand } from "../../../src/features/guild-state/commands/sweep-vanished-state.command.js";
import { UpsertChannelCommand } from "../../../src/features/guild-state/commands/upsert-channel.command.js";
import { UpsertRoleCommand } from "../../../src/features/guild-state/commands/upsert-role.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import {
	GUILD_STATE_BOUND_COMMANDS,
	GUILD_STATE_BOUND_EVENT_KINDS,
	GuildStateEventSubscription
} from "../../../src/features/guild-state/gateways/guild-state-event-subscription.gateway.js";
import type { GuildStateEventCommand } from "../../../src/features/guild-state/gateways/guild-state-event-subscription.gateway.js";
import type { RegistryGuild } from "../../../src/features/guild-state/models/domain/registry-records.js";
import type { GuildRegistryRepository } from "../../../src/features/guild-state/repositories/guild-registry.repository.js";
import type { DiscordIdentifier } from "../../../src/features/guild-state/models/domain/discord-identifier.js";
import { GetGuildStateStatusQuery } from "../../../src/features/guild-state/queries/get-guild-state-status.query.js";
import { FakeGuildStateGateway, role } from "./fakes/fake-guild-state-gateway.js";
import type { FakeGatewayProgram } from "./fakes/fake-guild-state-gateway.js";
import { FakeDiscordEventConsumer } from "./fakes/fake-discord-event-consumer.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T9a — the event-subscription binding (docs/features/guild-state.md Contracts: "Event-stream subscription …
 * use cases see normalized application events"; `odd/tasks/guild-state.md` T9a).
 *
 * The binding owns exactly one thing: the field-for-field mapping from a normalized kind onto a committed
 * command. So every case here asks the same question twice — what the command was handed, and what the
 * registry ended up holding — because either half alone can pass while the mapping is wrong. The commands'
 * own decisions (R3's refusal, R6's parent rule, R7's replacement, R8's deferral, R9's replay) are proven in
 * their own files; what is only provable here is that the binding does not undo them on the way in.
 *
 * Three shapes carry the risk, and each is asserted directly:
 *
 * - **Absent stays absent (R10).** An event that did not name a parent or an overwrite list is mapped to an
 *   input that does not name them either. `toEqual` on the whole input object is the assertion that makes
 *   this unfakeable: a binding that wrote `null` or `[]` for an absent field produces a different object, and
 *   the case below then leaves a stored overwrite set exactly as it was.
 * - **Direction (R8).** `thread-member-added` and `thread-member-removed` reach one command whose `change`
 *   field says which way. A binding that read the direction off the payload instead of the kind would compile
 *   and would turn a revocation into a grant.
 * - **Guild scope (R1).** Every bound kind is replayed with another Guild's id and must produce zero command
 *   calls, one counted anomaly, and a log line that names only the kind and two ids.
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const ROLE_BACKEND = "160000000000000010";
const ROLE_OPS = "160000000000000011";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const THREAD_PRIVATE = "160000000000000203";
const MESSAGE_ID = "160000000000000301";

const VIEW_CHANNEL = "1024";
const SEND_MESSAGES = "2048";

/* --------------------------------------------------------------------------- event fixtures */

/** The role fixtures name the fields the payload carried, and only those: absent is the case being tested. */
function roleCreated(
	roleId: string,
	fields: { roleName?: string; permissionsBitfield?: string } = {}
): RoleCreatedEvent {
	return { kind: Kind.roleCreated, guildId: GUILD_ID, roleId, ...fields };
}

function roleUpdated(
	roleId: string,
	fields: { roleName?: string; permissionsBitfield?: string } = {}
): RoleUpdatedEvent {
	return { kind: Kind.roleUpdated, guildId: GUILD_ID, roleId, ...fields };
}

function roleDeleted(roleId: string): RoleDeletedEvent {
	return { kind: Kind.roleDeleted, guildId: GUILD_ID, roleId };
}

function memberAdded(
	userId: string,
	roleIds: readonly string[],
	fields: { nickname?: string; joinedInstant?: Date; isPending?: boolean } = {}
): MemberAddedEvent {
	return { kind: Kind.memberAdded, guildId: GUILD_ID, userId, roleIds, ...fields };
}

function memberUpdated(
	userId: string,
	roleIds: readonly string[],
	fields: Partial<Pick<MemberUpdatedEvent, "nickname" | "joinedInstant" | "isPending">> = {}
): MemberUpdatedEvent {
	return { kind: Kind.memberUpdated, guildId: GUILD_ID, userId, roleIds, ...fields };
}

function memberRemoved(userId: string): MemberRemovedEvent {
	return { kind: Kind.memberRemoved, guildId: GUILD_ID, userId };
}

function channelCreated(
	channelId: string,
	fields: Partial<Omit<ChannelCreatedEvent, "kind" | "guildId" | "channelId">> = {}
): ChannelCreatedEvent {
	return { kind: Kind.channelCreated, guildId: GUILD_ID, channelId, channelType: "guild-text", ...fields };
}

function channelUpdated(
	channelId: string,
	fields: Partial<Omit<ChannelUpdatedEvent, "kind" | "guildId" | "channelId">> = {}
): ChannelUpdatedEvent {
	return { kind: Kind.channelUpdated, guildId: GUILD_ID, channelId, channelType: "guild-text", ...fields };
}

function channelDeleted(channelId: string): ChannelDeletedEvent {
	return { kind: Kind.channelDeleted, guildId: GUILD_ID, channelId, channelType: "guild-text" };
}

function threadCreated(
	threadId: string,
	fields: {
		parentChannelId?: string;
		name?: string;
		archived?: boolean;
		threadType?: "public-thread" | "private-thread";
		memberIds?: readonly string[];
	} = {}
): ThreadCreatedEvent {
	return { kind: Kind.threadCreated, guildId: GUILD_ID, threadId, threadType: "private-thread", ...fields };
}

function threadUpdated(
	threadId: string,
	fields: { parentChannelId?: string; archived?: boolean } = {}
): ThreadUpdatedEvent {
	return { kind: Kind.threadUpdated, guildId: GUILD_ID, threadId, threadType: "private-thread", ...fields };
}

function threadDeleted(threadId: string): ThreadDeletedEvent {
	return { kind: Kind.threadDeleted, guildId: GUILD_ID, threadId };
}

function threadMemberAdded(threadId: string, userId: string): ThreadMemberAddedEvent {
	return { kind: Kind.threadMemberAdded, guildId: GUILD_ID, threadId, userId };
}

function threadMemberRemoved(threadId: string, userId: string): ThreadMemberRemovedEvent {
	return { kind: Kind.threadMemberRemoved, guildId: GUILD_ID, threadId, userId };
}

function guildUpdated(fields: { guildName?: string; ownerId?: string; memberCount?: number } = {}): GuildUpdatedEvent {
	return { kind: Kind.guildUpdated, guildId: GUILD_ID, ...fields };
}

function resyncNeeded(
	epoch: number,
	fields: {
		reconnectAttempts?: number;
		lastDeliveredInstant?: Date;
		affectedKinds?: readonly DiscordEventKind[];
	} = {}
): ResyncNeededEvent {
	return { kind: Kind.resyncNeeded, guildId: GUILD_ID, epoch, reconnectAttempts: 1, ...fields };
}

/** One message event: the kind this feature never binds, so a foreign payload of any kind includes it. */
function messageCreated(): NormalizedDiscordEvent {
	return {
		kind: Kind.messageCreated,
		guildId: GUILD_ID,
		channelId: CHANNEL_PUBLIC,
		messageId: MESSAGE_ID,
		authorId: USER_ONE,
		content: "the answer is 42",
		createdInstant: new Date("2026-11-05T10:00:00.000Z"),
		messageType: "default"
	};
}

/* ---------------------------------------------------------------------------------- harness */

/**
 * A command wrapper that records the exact input object and then runs the real command. Recording the input
 * is what lets a case name absence — a wrapped command that had already lost the distinction between an
 * absent field and a `null` one could not prove anything about the mapping.
 */
class SpyCommand<Input, Output> implements GuildStateEventCommand<Input, Output> {
	public readonly inputs: Input[] = [];

	public constructor(private readonly inner: GuildStateEventCommand<Input, Output>) {}

	public readonly execute = async (input: Input): Promise<Output> => {
		this.inputs.push(input);
		return this.inner.execute(input);
	};

	public get callCount(): number {
		return this.inputs.length;
	}
}

/**
 * The Guild registry's recorder. The binding's one repository-shaped dependency is `GuildRegistryRepository
 * .upsertGuild` (Contracts lists "upsert Guild" as a repository operation, and the module resolves
 * `GUILD_STATE_GUILD_REGISTRY_TOKEN` into it), so the harness must hand it the *repository contract*, not a
 * `GuildStateEventCommand`: the command seam is `{ execute }` and a `{ execute }` object has no `upsertGuild`
 * to call. Recording the argument and delegating keeps the assertion the test wants — the exact row the
 * binding wrote — without inventing a method the committed contract does not have.
 */
class SpyGuildRegistry implements GuildRegistryRepository {
	public readonly inputs: RegistryGuild[] = [];

	public constructor(private readonly inner: GuildRegistryRepository) {}

	public readonly upsertGuild = async (guild: RegistryGuild): Promise<RegistryGuild> => {
		this.inputs.push(guild);
		return this.inner.upsertGuild(guild);
	};

	public readonly findGuild = async (guildId: DiscordIdentifier): Promise<RegistryGuild | null> =>
		this.inner.findGuild(guildId);

	public get callCount(): number {
		return this.inputs.length;
	}
}

interface BindingHarness {
	readonly binding: GuildStateEventSubscription;
	readonly consumer: FakeDiscordEventConsumer;
	readonly logger: RecordingLogger;
	readonly ledger: InMemoryGuildResyncLedger;
	readonly registries: RecordingRegistries;
	readonly gateway: FakeGuildStateGateway;
	readonly status: GetGuildStateStatusQuery;
	readonly spies: {
		readonly upsertGuild: SpyGuildRegistry;
		readonly upsertRole: SpyCommand<
			Parameters<UpsertRoleCommand["execute"]>[0],
			Awaited<ReturnType<UpsertRoleCommand["execute"]>>
		>;
		readonly deleteRole: SpyCommand<
			Parameters<DeleteRoleCommand["execute"]>[0],
			Awaited<ReturnType<DeleteRoleCommand["execute"]>>
		>;
		readonly applyMemberUpdate: SpyCommand<
			Parameters<ApplyMemberUpdateCommand["execute"]>[0],
			Awaited<ReturnType<ApplyMemberUpdateCommand["execute"]>>
		>;
		readonly endMembership: SpyCommand<
			Parameters<EndMembershipCommand["execute"]>[0],
			Awaited<ReturnType<EndMembershipCommand["execute"]>>
		>;
		readonly upsertChannel: SpyCommand<
			Parameters<UpsertChannelCommand["execute"]>[0],
			Awaited<ReturnType<UpsertChannelCommand["execute"]>>
		>;
		readonly deleteChannel: SpyCommand<
			Parameters<DeleteChannelCommand["execute"]>[0],
			Awaited<ReturnType<DeleteChannelCommand["execute"]>>
		>;
		readonly threadMembership: SpyCommand<
			Parameters<ApplyThreadMembershipChangeCommand["execute"]>[0],
			Awaited<ReturnType<ApplyThreadMembershipChangeCommand["execute"]>>
		>;
		readonly resync: SpyCommand<
			Parameters<ResyncGuildStateCommand["execute"]>[0],
			Awaited<ReturnType<ResyncGuildStateCommand["execute"]>>
		>;
	};
}

function bindingHarness(program: FakeGatewayProgram = {}): BindingHarness {
	const config = createGuildStateConfig({ guildId: GUILD_ID });
	const logger = new RecordingLogger();
	const registries = new RecordingRegistries();
	const ledger = new InMemoryGuildResyncLedger({ guildId: GUILD_ID });
	const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
	const gateway = new FakeGuildStateGateway(program, GUILD_ID);
	const consumer = new FakeDiscordEventConsumer();

	const upsertRoleCommand = new UpsertRoleCommand({ config, roleRegistry: registries.rolesContract, logger });
	const bootstrapCommand = new ApplyGuildBootstrapCommand({
		config,
		gateway,
		tracker,
		guildRegistry: registries.guildsContract,
		roleRegistry: registries.rolesContract,
		channelRegistry: registries.channelsContract,
		membershipRegistry: registries.membershipsContract,
		threadMembershipRegistry: registries.threadMembershipsContract,
		logger
	});
	const resyncCommand = new ResyncGuildStateCommand({
		config,
		gateway,
		tracker,
		ledger,
		bootstrapCommand,
		upsertRoleCommand,
		// Its own delete commands, not the spies': this file counts what an *event* reached, and a sweep is not
		// an event. The rows it removes are still the real doubles' rows.
		sweepCommand: new SweepVanishedStateCommand({
			config,
			membershipRegistry: registries.membershipsContract,
			roleRegistry: registries.rolesContract,
			channelRegistry: registries.channelsContract,
			deleteRoleCommand: new DeleteRoleCommand({ config, roleRegistry: registries.rolesContract, logger }),
			deleteChannelCommand: new DeleteChannelCommand({
				config,
				channelRegistry: registries.channelsContract,
				logger
			}),
			logger
		}),
		roleRegistry: registries.rolesContract,
		channelRegistry: registries.channelsContract,
		logger
	});

	const spies = {
		upsertGuild: new SpyGuildRegistry(registries.guildsContract),
		upsertRole: new SpyCommand({ execute: upsertRoleCommand.execute }),
		deleteRole: new SpyCommand({
			execute: new DeleteRoleCommand({ config, roleRegistry: registries.rolesContract, logger }).execute
		}),
		applyMemberUpdate: new SpyCommand({
			execute: new ApplyMemberUpdateCommand({
				config,
				roleRegistry: registries.rolesContract,
				membershipRegistry: registries.membershipsContract,
				logger
			}).execute
		}),
		endMembership: new SpyCommand({
			execute: new EndMembershipCommand({ config, membershipRegistry: registries.membershipsContract, logger })
				.execute
		}),
		upsertChannel: new SpyCommand({
			execute: new UpsertChannelCommand({ config, channelRegistry: registries.channelsContract, logger }).execute
		}),
		deleteChannel: new SpyCommand({
			execute: new DeleteChannelCommand({ config, channelRegistry: registries.channelsContract, logger }).execute
		}),
		threadMembership: new SpyCommand({
			execute: new ApplyThreadMembershipChangeCommand({
				config,
				channelRegistry: registries.channelsContract,
				threadMembershipRegistry: registries.threadMembershipsContract,
				logger
			}).execute
		}),
		resync: new SpyCommand({ execute: resyncCommand.execute })
	};

	const binding = new GuildStateEventSubscription({
		config,
		logger,
		consumer,
		ledger,
		guildRegistry: spies.upsertGuild,
		upsertRole: spies.upsertRole,
		deleteRole: spies.deleteRole,
		applyMemberUpdate: spies.applyMemberUpdate,
		endMembership: spies.endMembership,
		upsertChannel: spies.upsertChannel,
		deleteChannel: spies.deleteChannel,
		applyThreadMembershipChange: spies.threadMembership,
		resync: spies.resync
	});

	const status = new GetGuildStateStatusQuery({
		config,
		tracker,
		ledger,
		guildRegistry: registries.guildsContract,
		logger
	});

	return { binding, consumer, logger, ledger, registries, gateway, status, spies };
}

/** The command-call count across every bound command, which is how "nothing reached a command" is asserted. */
function totalCalls(spies: BindingHarness["spies"]): number {
	return Object.values(spies).reduce((count, spy) => count + spy.callCount, 0);
}

/** A distinct event of every bound kind, all naming `guildId`. */
function oneEventPerBoundKind(guildId: string): NormalizedDiscordEvent[] {
	const withGuild = (event: NormalizedDiscordEvent): NormalizedDiscordEvent => ({ ...event, guildId });
	return [
		guildUpdated({ guildName: "Renewed" }),
		roleCreated(ROLE_BACKEND, { roleName: "backend", permissionsBitfield: VIEW_CHANNEL }),
		roleUpdated(ROLE_BACKEND, { roleName: "backend", permissionsBitfield: VIEW_CHANNEL }),
		roleDeleted(ROLE_BACKEND),
		memberAdded(USER_ONE, [ROLE_BACKEND]),
		memberUpdated(USER_ONE, [ROLE_BACKEND]),
		memberRemoved(USER_ONE),
		channelCreated(CHANNEL_PUBLIC, { name: "public" }),
		channelUpdated(CHANNEL_PUBLIC, { name: "public" }),
		channelDeleted(CHANNEL_PUBLIC),
		threadCreated(THREAD_PRIVATE, { parentChannelId: CHANNEL_PRIVATE }),
		threadUpdated(THREAD_PRIVATE, { parentChannelId: CHANNEL_PRIVATE }),
		threadDeleted(THREAD_PRIVATE),
		threadMemberAdded(THREAD_PRIVATE, USER_ONE),
		threadMemberRemoved(THREAD_PRIVATE, USER_ONE),
		resyncNeeded(7)
	].map(withGuild);
}

describe("guild-state event subscription (T9a)", () => {
	/* ---------------------------------------------------------------------------- role: R3 */

	it("maps role-created onto UpsertRoleCommand field for field (R3)", async () => {
		const { binding, spies } = bindingHarness();

		const disposition = await binding.handle(
			roleCreated(ROLE_BACKEND, { roleName: "backend", permissionsBitfield: VIEW_CHANNEL })
		);

		expect(spies.upsertRole.inputs).toEqual([
			{
				guildId: GUILD_ID,
				roleId: ROLE_BACKEND,
				roleName: "backend",
				permissionsBitfield: VIEW_CHANNEL
			}
		]);
		expect(disposition.status).toBe("applied");
		expect(disposition.status === "applied" && disposition.command).toBe("upsert-role");
		expect(spies.deleteRole.inputs).toEqual([]);
	});

	it("maps role-updated onto the same UpsertRoleCommand, not a merge (R3, R10)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(roleUpdated(ROLE_BACKEND, { roleName: "renamed", permissionsBitfield: SEND_MESSAGES }));

		expect(spies.upsertRole.inputs).toEqual([
			{
				guildId: GUILD_ID,
				roleId: ROLE_BACKEND,
				roleName: "renamed",
				permissionsBitfield: SEND_MESSAGES
			}
		]);
	});

	it("leaves an omitted role name and bitfield absent in the command input, so the command decides (R3, R10)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(roleCreated(ROLE_BACKEND));

		// `toEqual` on the whole object: an invented `roleName: undefined`, `null` or `""` would not match.
		expect(spies.upsertRole.inputs).toEqual([{ guildId: GUILD_ID, roleId: ROLE_BACKEND }]);
		expect(spies.upsertRole.inputs[0]).not.toHaveProperty("roleName");
		expect(spies.upsertRole.inputs[0]).not.toHaveProperty("permissionsBitfield");
	});

	it("maps role-deleted onto DeleteRoleCommand with nothing but the two ids (R3)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(roleDeleted(ROLE_BACKEND));

		expect(spies.deleteRole.inputs).toEqual([{ guildId: GUILD_ID, roleId: ROLE_BACKEND }]);
		expect(spies.upsertRole.inputs).toEqual([]);
	});

	/* ----------------------------------------------------------------------- membership: R4, R5 */

	it("maps member-added onto ApplyMemberUpdateCommand with the complete role set (R4, R5)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(memberAdded(USER_ONE, [ROLE_BACKEND, ROLE_OPS]));

		expect(spies.applyMemberUpdate.inputs).toEqual([
			{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND, ROLE_OPS] }
		]);
	});

	it("maps member-updated onto the same command and carries no display data at all (R5, R14, O2)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(
			memberUpdated(USER_ONE, [ROLE_BACKEND], { nickname: "Nickname-That-Must-Not-TravEL", isPending: false })
		);

		const [input] = spies.applyMemberUpdate.inputs;
		// The whole key set, sorted: a nickname, a join instant or a pending flag could not be present at all.
		// An absent recorded input fails here too — `Object.keys({})` is not the three keys the binding must send.
		expect(Object.keys(input ?? {}).sort()).toEqual(["guildId", "roleIds", "userId"]);
		expect(input?.roleIds).toEqual([ROLE_BACKEND]);
	});

	it("maps member-removed onto EndMembershipCommand, the same fact for leave, kick and ban (R4)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(memberRemoved(USER_ONE));

		expect(spies.endMembership.inputs).toEqual([{ guildId: GUILD_ID, userId: USER_ONE }]);
	});

	/* ---------------------------------------------------------------------- channels: R6, R7, R10 */

	it("maps channel-created onto UpsertChannelCommand, parent and overwrite set included (R6, R7)", async () => {
		const { binding, spies } = bindingHarness();
		const overwrites = [
			{ targetId: ROLE_BACKEND, targetType: "role" as const, allowBitfield: SEND_MESSAGES, denyBitfield: "0" }
		];

		await binding.handle(
			channelCreated(CHANNEL_PUBLIC, {
				name: "public",
				parentId: CHANNEL_PRIVATE,
				permissionOverwrites: overwrites
			})
		);

		expect(spies.upsertChannel.inputs).toEqual([
			{
				guildId: GUILD_ID,
				channelId: CHANNEL_PUBLIC,
				channelType: "guild-text",
				name: "public",
				parentChannelId: CHANNEL_PRIVATE,
				permissionOverwrites: overwrites
			}
		]);
	});

	it("maps channel-updated onto UpsertChannelCommand (R6)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(channelUpdated(CHANNEL_PUBLIC, { name: "renamed" }));

		expect(spies.upsertChannel.inputs).toEqual([
			{ guildId: GUILD_ID, channelId: CHANNEL_PUBLIC, channelType: "guild-text", name: "renamed" }
		]);
	});

	it("keeps an absent parent and an absent overwrite list ABSENT in the mapped input (R10)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(channelCreated(CHANNEL_PUBLIC));

		expect(spies.upsertChannel.inputs).toEqual([
			{ guildId: GUILD_ID, channelId: CHANNEL_PUBLIC, channelType: "guild-text" }
		]);
		expect(spies.upsertChannel.inputs[0]).not.toHaveProperty("parentChannelId");
		expect(spies.upsertChannel.inputs[0]).not.toHaveProperty("permissionOverwrites");
		expect(spies.upsertChannel.inputs[0]).not.toHaveProperty("name");
	});

	it("an update that said nothing leaves the stored overwrite set exactly as it was (R7, R10)", async () => {
		const { binding, registries, spies } = bindingHarness();
		const stored = [
			{ targetId: ROLE_BACKEND, targetType: "role" as const, allowBitfield: SEND_MESSAGES, denyBitfield: "0" }
		];

		await binding.handle(channelCreated(CHANNEL_PUBLIC, { permissionOverwrites: stored }));
		// The committed double keys an overwrite set by channel id — `findChannelOverwrites(guildId, channelId)
		// scopes the Guild inside the statement, not in the key — so the read-back uses that same key.
		const before = [...(registries.overwriteEntries.get(CHANNEL_PUBLIC) ?? [])];
		expect(before).toHaveLength(1);

		// The silent update: no `permission_overwrites` in the payload at all.
		const disposition = await binding.handle(channelUpdated(CHANNEL_PUBLIC));
		const outcome = disposition.status === "applied" ? disposition.outcome : null;

		// The disposition's outcome is the union of every bound command's outcome, so the fact this case names is
		// read through its own presence: only the channel command reports a whole-set replacement.
		const replaced =
			outcome !== null && "overwriteSetReplaced" in outcome ? outcome.overwriteSetReplaced : undefined;
		expect(replaced).toBe(false);
		expect([...(registries.overwriteEntries.get(CHANNEL_PUBLIC) ?? [])]).toEqual(before);
		expect(spies.upsertChannel.callCount).toBe(2);
	});

	it("maps thread-created onto UpsertChannelCommand with the thread id and type, and no invented parent (R6, R10)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(
			threadCreated(THREAD_PRIVATE, { parentChannelId: CHANNEL_PRIVATE, name: "incident", archived: false })
		);

		expect(spies.upsertChannel.inputs).toEqual([
			{
				guildId: GUILD_ID,
				channelId: THREAD_PRIVATE,
				channelType: "private-thread",
				name: "incident",
				parentChannelId: CHANNEL_PRIVATE
			}
		]);
		expect(spies.upsertChannel.inputs[0]).not.toHaveProperty("permissionOverwrites");
	});

	it("maps thread-updated onto UpsertChannelCommand and keeps an absent parent absent (R6, R10)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(threadUpdated(THREAD_PRIVATE, { archived: true }));

		expect(spies.upsertChannel.inputs).toEqual([
			{ guildId: GUILD_ID, channelId: THREAD_PRIVATE, channelType: "private-thread" }
		]);
		expect(spies.upsertChannel.inputs[0]).not.toHaveProperty("parentChannelId");
	});

	it("does not turn a thread-create member list into membership edges (R8, O1)", async () => {
		const { binding, registries, spies } = bindingHarness();

		await binding.handle(
			threadCreated(THREAD_PRIVATE, { parentChannelId: CHANNEL_PRIVATE, memberIds: [USER_ONE, USER_TWO] })
		);

		// R8 makes an edge a thread-member fact; the create payload's list is not that read, so no call, no row.
		expect(spies.threadMembership.inputs).toEqual([]);
		expect(registries.threadMemberships.get(THREAD_PRIVATE) ?? []).toEqual([]);
	});

	it("maps channel-deleted onto DeleteChannelCommand and thread-deleted onto the same command (R6)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(channelDeleted(CHANNEL_PUBLIC));
		await binding.handle(threadDeleted(THREAD_PRIVATE));

		expect(spies.deleteChannel.inputs).toEqual([
			{ guildId: GUILD_ID, channelId: CHANNEL_PUBLIC },
			{ guildId: GUILD_ID, channelId: THREAD_PRIVATE }
		]);
	});

	/* ------------------------------------------------------------------- thread membership: R8 */

	it('maps thread-member-added onto ApplyThreadMembershipChangeCommand with change "added" (R8)', async () => {
		const { binding, registries, spies } = bindingHarness();
		await binding.handle(threadCreated(THREAD_PRIVATE, { parentChannelId: CHANNEL_PRIVATE }));
		// The parent has to be a registered row for R6 to accept the thread at all.
		await binding.handle(channelCreated(CHANNEL_PRIVATE, { channelType: "guild-category" }));
		await binding.handle(threadCreated(THREAD_PRIVATE, { parentChannelId: CHANNEL_PRIVATE }));

		await binding.handle(threadMemberAdded(THREAD_PRIVATE, USER_ONE));

		expect(spies.threadMembership.inputs).toContainEqual({
			guildId: GUILD_ID,
			threadId: THREAD_PRIVATE,
			userId: USER_ONE,
			change: "added"
		});
		expect(registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([USER_ONE]);
	});

	it('maps thread-member-removed onto the same command with change "removed", read off the kind (R8)', async () => {
		const { binding, registries, spies } = bindingHarness();
		await binding.handle(channelCreated(CHANNEL_PRIVATE));
		await binding.handle(threadCreated(THREAD_PRIVATE, { parentChannelId: CHANNEL_PRIVATE }));
		await binding.handle(threadMemberAdded(THREAD_PRIVATE, USER_ONE));
		expect(registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([USER_ONE]);

		await binding.handle(threadMemberRemoved(THREAD_PRIVATE, USER_ONE));

		const last = spies.threadMembership.inputs[spies.threadMembership.inputs.length - 1]!;
		expect(last.change).toBe("removed");
		expect(registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([]);
	});

	/* --------------------------------------------------------------------------------- guild */

	it("maps a guild-updated that named a name onto the registry's guild upsert, with the configured id (R1, R2)", async () => {
		const { binding, registries, spies } = bindingHarness();

		const disposition = await binding.handle(
			guildUpdated({ guildName: "Example Guild HQ Renamed", ownerId: USER_ONE, memberCount: 99 })
		);

		expect(spies.upsertGuild.inputs).toEqual([{ guildId: GUILD_ID, guildName: "Example Guild HQ Renamed" }]);
		expect(registries.guilds.get("guild")?.guildName).toBe("Example Guild HQ Renamed");
		expect(disposition.status === "applied" && disposition.command).toBe("upsert-guild");
	});

	it("writes nothing for a guild-updated that named no name, and says why (R10)", async () => {
		const { binding, registries, spies } = bindingHarness();
		await binding.handle(guildUpdated({ guildName: "Example Guild HQ" }));

		const disposition = await binding.handle(guildUpdated({ ownerId: USER_ONE, memberCount: 100 }));

		expect(disposition).toEqual({ kind: Kind.guildUpdated, reason: "guild-name-absent", status: "ignored" });
		expect(spies.upsertGuild.callCount).toBe(1);
		expect(registries.guilds.get("guild")?.guildName).toBe("Example Guild HQ");
	});

	/* ------------------------------------------------------------------------------- resync */

	it("maps resync-needed onto ResyncGuildStateCommand: epoch, guild, its own label as reason (R11)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(
			resyncNeeded(3, { reconnectAttempts: 2, lastDeliveredInstant: new Date("2026-11-05T00:00:00.000Z") })
		);

		expect(spies.resync.inputs).toHaveLength(1);
		const input = spies.resync.inputs[0]!;
		expect(input.epoch).toBe(3);
		expect(input.guildId).toBe(GUILD_ID);
		expect(input.reason).toBe("resync-needed");
		// Absent for a whole-connection gap: `undefined` in the input would be a different statement (R5, R10).
		expect(input).not.toHaveProperty("affectedKinds");
		expect(input).not.toHaveProperty("force");
		expect(input.gaps).toEqual([]);
	});

	it("narrows a resync signal only when the signal itself was narrowed (R5, R11)", async () => {
		const { binding, spies } = bindingHarness();

		await binding.handle(resyncNeeded(4, { affectedKinds: [Kind.memberRemoved, Kind.roleDeleted] }));

		expect(spies.resync.inputs[0]!.affectedKinds).toEqual([Kind.memberRemoved, Kind.roleDeleted]);
	});

	it("declares the anomalies the event path reported to the next resync, and stops declaring the ones that closed (R3, R11)", async () => {
		// The REST role read is what completes the refused role, so the program carries the whole description.
		const program: FakeGatewayProgram = { roles: [role(GUILD_ID, ROLE_BACKEND, VIEW_CHANNEL, 1)] };
		const { binding, ledger, spies, status } = bindingHarness(program);

		// An event that described a brand-new role incompletely: T3 refuses it and reports the missing fields.
		const refused = await binding.handle(roleCreated(ROLE_BACKEND, { roleName: "backend" }));
		expect(refused.status).toBe("refused");
		expect(refused.status === "refused" && refused.recordedGaps).toEqual([
			{
				kind: "role-incomplete-description",
				resourceId: ROLE_BACKEND,
				reason: "incomplete-role-description",
				pendingFields: ["permissionsBitfield"]
			}
		]);
		expect(ledger.snapshot().openGaps.map((gap) => gap.kind)).toEqual(["role-incomplete-description"]);
		// The T8 derivation is the single source of truth and its order is unavailable → stale-in-flight →
		// incomplete → stale-open-gaps → current. Nothing has been bootstrapped in this fixture, so a pending
		// part list outranks the one open gap and the honest answer is `incomplete` — never `current`. That
		// anomalies-only `stale` (every part applied, one gap open) is pinned in
		// `get-guild-state-status.query.test.ts` ("an unresolved gap holds the status stale even with every part
		// applied"), so what this case owns is the declaration path, not the precedence.
		expect((await status.execute()).status).toBe("incomplete");

		await binding.handle(resyncNeeded(1));
		expect(spies.resync.inputs[0]!.gaps).toEqual([
			{
				kind: "role-incomplete-description",
				resourceId: ROLE_BACKEND,
				reason: "incomplete-role-description",
				pendingFields: ["permissionsBitfield"]
			}
		]);

		// The run closed it: the role row exists now, so the same signal declares nothing further (R9).
		expect(spies.resync.inputs[0]!.gaps).toHaveLength(1);
		await binding.handle(resyncNeeded(2));
		expect(spies.resync.inputs[1]!.gaps).toEqual([]);
		expect(ledger.snapshot().openGaps).toEqual([]);
		expect((await status.execute()).status).toBe("current");
	});

	it("replaying a refused event keeps one report, not two (R9)", async () => {
		const { binding, ledger } = bindingHarness();

		await binding.handle(roleCreated(ROLE_BACKEND, { roleName: "backend" }));
		await binding.handle(roleCreated(ROLE_BACKEND, { roleName: "backend" }));

		expect(ledger.snapshot().openGaps).toHaveLength(1);
	});

	it("records a member set naming an unknown role as a deferred-role gap (R5)", async () => {
		const { binding, ledger, registries } = bindingHarness();

		const disposition = await binding.handle(memberAdded(USER_ONE, [ROLE_BACKEND]));

		expect(disposition.status).toBe("applied");
		expect(registries.memberships.get(USER_ONE)?.roleIds).toEqual([]);
		expect(ledger.snapshot().openGaps).toEqual([
			{ kind: "role-id-deferred", resourceId: ROLE_BACKEND, reason: "role-id-deferred" }
		]);
	});

	it("records the unknown-thread deferral as an unobserved-membership gap, and nothing for a non-thread (R8, O1)", async () => {
		const { binding, ledger, registries } = bindingHarness();

		await binding.handle(threadMemberAdded("160000000000009999", USER_ONE));
		expect(ledger.snapshot().openGaps).toEqual([
			{ kind: "thread-membership-unobserved", resourceId: "160000000000009999", reason: "unknown-thread" }
		]);

		// A row that exists but is not a thread: R6's registry says so, and there is no gap kind for that fact.
		await binding.handle(channelCreated(CHANNEL_PUBLIC));
		const notAThread = await binding.handle(threadMemberAdded(CHANNEL_PUBLIC, USER_ONE));
		expect(notAThread.status).toBe("refused");
		expect(notAThread.status === "refused" && notAThread.reason).toBe("not-a-thread");
		// The claim is about the thread fact, and the ledger keys a gap by kind and resource (R9): the unknown
		// thread above is one unobserved-membership gap, and the `not-a-thread` refusal added nothing to it.
		// The ledger holds two gaps in total because the channel that made the refusal reachable is itself a
		// distinct R10 fact (`channel-pending-rest-fields`, pinned by the next case) — two different resources,
		// not two reports of one fact.
		expect(ledger.gapsOf("thread-membership-unobserved")).toEqual([
			{ kind: "thread-membership-unobserved", resourceId: "160000000000009999", reason: "unknown-thread" }
		]);
		expect(ledger.snapshot().openGaps.map((gap) => gap.kind)).toEqual([
			"thread-membership-unobserved",
			"channel-pending-rest-fields"
		]);
		expect(registries.threadMemberships.size).toBe(0);
	});

	it("records a channel that carried no overwrite list as a pending-REST-fields gap (R7, R10, R11)", async () => {
		const { binding, ledger } = bindingHarness();

		await binding.handle(channelCreated(CHANNEL_PUBLIC));

		expect(ledger.snapshot().openGaps).toEqual([
			{
				kind: "channel-pending-rest-fields",
				resourceId: CHANNEL_PUBLIC,
				reason: "payload-carried-no-overwrite-set",
				pendingFields: ["permissionOverwrites"]
			}
		]);
	});

	/* ------------------------------------------------------------------- the bound-kind table */

	it("subscribes exactly the guild-state kinds, once each, and no message kind (R1, Contracts)", () => {
		const { binding, consumer } = bindingHarness();

		const report = binding.subscribe();

		expect(consumer.boundKinds).toEqual([...GUILD_STATE_BOUND_EVENT_KINDS]);
		expect(report.boundKinds).toEqual([...GUILD_STATE_BOUND_EVENT_KINDS]);
		for (const kind of GUILD_STATE_BOUND_EVENT_KINDS) {
			expect(consumer.handlerCountFor(kind), kind).toBe(1);
		}
		// The four message kinds are ingestion's, and are never registered here.
		for (const kind of [
			Kind.messageCreated,
			Kind.messageUpdated,
			Kind.messageDeleted,
			Kind.messageBulkDeleted
		] as const) {
			expect(consumer.handlerCountFor(kind), kind).toBe(0);
		}
		expect(binding.isSubscribed).toBe(true);
	});

	it("leaves bans unbound because the normalized vocabulary publishes no ban kind yet (O3, R4)", () => {
		// The whole published vocabulary, searched for a ban: the absence is the finding, and it is asserted
		// against the other feature's contract rather than against this file's memory of it.
		const banKinds = DISCORD_EVENT_KINDS.filter((kind) => kind.includes("ban"));
		expect(banKinds).toEqual([]);
		expect(GUILD_STATE_BOUND_EVENT_KINDS.filter((kind) => kind.includes("ban"))).toEqual([]);

		// A ban still ends the Membership, because Discord also sends the member removal (R4).
		const bound = new Set<string>(GUILD_STATE_BOUND_EVENT_KINDS);
		expect(bound.has(Kind.memberRemoved)).toBe(true);
	});

	it("subscribing twice registers nothing twice, and unsubscribing stops every registration (R9)", async () => {
		const { binding, consumer } = bindingHarness();

		binding.subscribe();
		binding.subscribe();
		expect(consumer.boundKinds).toEqual([...GUILD_STATE_BOUND_EVENT_KINDS]);

		binding.unsubscribe();
		expect(consumer.boundKinds).toEqual([]);
		expect(binding.isSubscribed).toBe(false);
		expect(consumer.history.every((entry) => entry.unsubscribed)).toBe(true);

		// Delivering after an unsubscribe reaches nothing: the registry cannot move on a stopped subscription.
		const registries = bindingHarness().registries;
		expect(registries).toBeDefined();
		const disposition = await binding.handle(roleDeleted(ROLE_BACKEND));
		expect(disposition.status).toBe("applied");
	});

	it("a delivered event reaches its command through the registered handler (R1, Contracts)", async () => {
		const { binding, consumer, spies } = bindingHarness();
		binding.subscribe();

		await consumer.deliver(roleCreated(ROLE_BACKEND, { roleName: "backend", permissionsBitfield: VIEW_CHANNEL }));

		expect(spies.upsertRole.inputs).toEqual([
			{ guildId: GUILD_ID, roleId: ROLE_BACKEND, roleName: "backend", permissionsBitfield: VIEW_CHANNEL }
		]);
	});

	it("reports a kind it does not bind instead of applying or ignoring it silently (Contracts)", async () => {
		const { binding, spies } = bindingHarness();

		const disposition = await binding.handle(messageCreated());

		expect(disposition).toEqual({ kind: Kind.messageCreated, reason: "kind-not-bound", status: "ignored" });
		expect(totalCalls(spies)).toBe(0);
	});

	it("names every bound kind with a command that exists, and every command a kind that exists", () => {
		// The table is the mapping: an unbound kind or an unreachable command is a silent decision.
		expect([...GUILD_STATE_BOUND_COMMANDS]).toEqual([
			"upsert-role",
			"delete-role",
			"apply-member-update",
			"end-membership",
			"upsert-channel",
			"delete-channel",
			"apply-thread-membership-change",
			"resync-guild-state",
			"upsert-guild"
		]);
		expect(GUILD_STATE_BOUND_EVENT_KINDS.length).toBe(16);
	});

	/* --------------------------------------------------------------------------- guild scope: R1 */

	/**
	 * R1 asserted at the edge rather than inherited from the stream: one event of every bound kind, each naming
	 * another Guild. The fixture is the whole bound vocabulary so the case cannot quietly stop covering a kind,
	 * and the assertion is the whole surface: nothing reached a command, nothing reached a registry, the anomaly
	 * is counted once per event, and the log line names only the kind and the two Guild ids (R14's boundary).
	 */
	it("drops one event of every bound kind that names another Guild, before any command sees it (R1)", async () => {
		const { binding, logger, ledger, registries, spies, status } = bindingHarness();
		const foreign = oneEventPerBoundKind(OTHER_GUILD_ID);
		// The fixture covers the table, or this case is silently narrower than it claims.
		expect(foreign.map((event) => event.kind)).toEqual([...GUILD_STATE_BOUND_EVENT_KINDS]);

		const dispositions = [];
		for (const event of foreign) {
			dispositions.push(await binding.handle(event));
		}

		for (const disposition of dispositions) {
			expect(disposition.status).toBe("dropped");
			if (disposition.status === "dropped") {
				expect(disposition.reason).toBe("foreign-guild");
				expect(disposition.eventGuildId).toBe(OTHER_GUILD_ID);
			}
		}
		// No command ran, so no registry write happened — the rows are the proof, not the return value.
		expect(totalCalls(spies)).toBe(0);
		expect(registries.state()).toEqual({
			guild: null,
			roles: [],
			memberships: [],
			channels: [],
			overwrites: [],
			threadMemberships: []
		});
		expect(registries.writes).toEqual([]);

		// One counted anomaly per dropped event, and nothing else counted.
		expect(ledger.snapshot().anomalyCounts["foreign-guild"]).toBe(foreign.length);
		expect(ledger.snapshot().openGaps).toEqual([]);

		// The drop log is ids and the kind: never a name, a bitfield or a payload field (R14's boundary case).
		const drops = logger.lines.filter((line) => line.message.includes("another guild"));
		expect(drops).toHaveLength(foreign.length);
		for (const line of drops) {
			expect(Object.keys(line.fields).sort()).toEqual(["eventGuildId", "guildId", "kind", "operation"]);
			expect(line.level).toBe("warn");
		}
		expect(logger.transcript()).not.toContain("backend");
		expect(logger.transcript()).not.toContain("public");
		expect(logger.transcript()).not.toContain(VIEW_CHANNEL);

		// And the registry the drop protected is still the empty one it was: a foreign event cannot even move
		// the status, because it never reached the gap path.
		expect((await status.execute()).status).toBe("incomplete");
		expect((await status.execute()).guildRegistered).toBe(false);
	});

	/**
	 * The same sweep delivered through the registered handlers rather than handed to `handle` directly: the
	 * subscription and the direct call must be one code path, or the edge the composition uses is the one that
	 * was never tested.
	 */
	it("drops the foreign kinds on the delivered path too, not only on a direct call (R1, Contracts)", async () => {
		const { binding, consumer, ledger, spies } = bindingHarness();
		binding.subscribe();

		for (const event of oneEventPerBoundKind(OTHER_GUILD_ID)) {
			expect(await consumer.deliver(event)).toBe(1);
		}

		expect(totalCalls(spies)).toBe(0);
		expect(ledger.snapshot().anomalyCounts["foreign-guild"]).toBe(GUILD_STATE_BOUND_EVENT_KINDS.length);
	});

	/** A configured-Guild event must still be applied after a foreign one: the drop is per event, not a mode. */
	it("keeps applying the configured Guild's events after dropping another Guild's (R1)", async () => {
		const { binding, ledger, registries, spies } = bindingHarness();

		await binding.handle(roleCreated(ROLE_BACKEND, { roleName: "backend", permissionsBitfield: VIEW_CHANNEL }));
		await binding.handle(roleDeleted(ROLE_BACKEND));
		const own = await binding.handle(
			roleCreated(ROLE_BACKEND, { roleName: "backend", permissionsBitfield: VIEW_CHANNEL })
		);

		expect(own.status).toBe("applied");
		expect(spies.upsertRole.callCount).toBe(2);
		expect([...registries.roles.keys()]).toEqual([ROLE_BACKEND]);
		expect(ledger.snapshot().anomalyCounts["foreign-guild"]).toBeUndefined();
	});
});
