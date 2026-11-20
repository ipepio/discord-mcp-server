import type { ChannelPermissionOverwrite } from "../../../../src/features/discord/index.js";
import type { DiscordIdentifier } from "../../../../src/features/guild-state/models/domain/discord-identifier.js";
import type {
	RegistryBatchWriteResult,
	RegistryChannel,
	RegistryChannelOverwriteSet,
	RegistryChannelRemovalResult,
	RegistryGuild,
	RegistryMembership,
	RegistryMembershipRemovalResult,
	RegistryOverwriteReplacementResult,
	RegistryRole,
	RegistryRolePermission,
	RegistryRoleRemovalResult,
	RegistryRoleSetReplacementResult,
	RegistryThreadMembership,
	RegistryThreadMembershipReplacementResult,
	RegistryThreadMembershipSet
} from "../../../../src/features/guild-state/models/domain/registry-records.js";
import type { ChannelRegistryRepository } from "../../../../src/features/guild-state/repositories/channel-registry.repository.js";
import type { GuildRegistryRepository } from "../../../../src/features/guild-state/repositories/guild-registry.repository.js";
import type { MembershipRegistryRepository } from "../../../../src/features/guild-state/repositories/membership-registry.repository.js";
import type { RoleRegistryRepository } from "../../../../src/features/guild-state/repositories/role-registry.repository.js";
import type { ThreadMembershipRegistryRepository } from "../../../../src/features/guild-state/repositories/thread-membership-registry.repository.js";

/**
 * The registry's test doubles, and the reason the bootstrap's resumability claim is testable at all.
 *
 * They are not call recorders only: each one holds rows and applies the same natural-key rules the
 * PostgreSQL adapters apply — upsert on Discord's id, replace the child set wholesale, delete with the
 * cascade (docs/features/guild-state.md R9, R10). That is what lets a unit test prove the real statement:
 * "re-running the bootstrap over a converged registry changes nothing observable" is a property of the write
 * semantics, so the double has to share those semantics. The SQL itself is proven separately, against a real
 * PostgreSQL, in `tests/integration/guild-state-registry.integration.test.ts`; this file exists so a test can
 * assert *which writes a pass issued* without a database, and can fail a statement at will.
 *
 * Every write is recorded as an ordered transaction log, so a test can see a pass stop exactly where the
 * provider stopped it.
 */

/** One recorded write: the operation, the rows it carried, and the transaction it belonged to. */
export interface RecordedRegistryWrite {
	readonly operation: string;
	readonly rows: number;
	/** Incremented per statement, so "guild before roles before channels" is assertable as an order. */
	readonly sequence: number;
}

export interface RecordingRegistryOptions {
	/** Fail the nth write of the named operation, 1-based; models a statement failing mid-pass. */
	readonly failOperation?: string;
	readonly failAfterWrites?: number;
}

/** The whole stored registry as the doubles hold it, for direct comparison between runs. */
export interface RecordedRegistryState {
	readonly guild: RegistryGuild | null;
	readonly roles: readonly RegistryRole[];
	readonly memberships: readonly RegistryMembership[];
	readonly channels: readonly RegistryChannel[];
	/** Each entry is the channel/thread id paired with its target keys, sorted, so two runs compare directly. */
	readonly overwrites: readonly (readonly [string, readonly string[]])[];
	readonly threadMemberships: readonly (readonly [string, readonly string[]])[];
}

/**
 * The channel types the adapter treats as threads, restated here on purpose. The double must apply R6's parent
 * rule from its own copy of the vocabulary, because a double that asked production code whether a row is a
 * thread could not notice production code changing its mind.
 */
const DOUBLE_THREAD_CHANNEL_TYPES: readonly string[] = ["announcement-thread", "public-thread", "private-thread"];

export class RecordingRegistries {
	public readonly writes: RecordedRegistryWrite[] = [];

	public readonly guilds = new Map<string, RegistryGuild>();

	public readonly roles = new Map<string, RegistryRole>();

	public readonly memberships = new Map<string, RegistryMembership>();

	public readonly channels = new Map<string, RegistryChannel>();

	public readonly overwrites = new Map<string, readonly string[]>();

	/** The same overwrite sets with their bitfields, which is what `findChannelOverwrites` must read back (R7). */
	public readonly overwriteEntries = new Map<string, readonly ChannelPermissionOverwrite[]>();

	public readonly threadMemberships = new Map<string, readonly string[]>();

	private readonly guildRegistryHandle = new GuildRegistryDouble(this);

	private readonly roleRegistryHandle = new RoleRegistryDouble(this);

	private readonly membershipRegistryHandle = new MembershipRegistryDouble(this);

	private readonly channelRegistryHandle = new ChannelRegistryDouble(this);

	private readonly threadMembershipRegistryHandle = new ThreadMembershipRegistryDouble(this);

	public constructor(private readonly options: RecordingRegistryOptions = {}) {}

	public get guildsContract(): GuildRegistryRepository {
		return this.guildRegistryHandle;
	}

	public get rolesContract(): RoleRegistryRepository {
		return this.roleRegistryHandle;
	}

	public get membershipsContract(): MembershipRegistryRepository {
		return this.membershipRegistryHandle;
	}

	public get channelsContract(): ChannelRegistryRepository {
		return this.channelRegistryHandle;
	}

	public get threadMembershipsContract(): ThreadMembershipRegistryRepository {
		return this.threadMembershipRegistryHandle;
	}

	public writesOf(operation: string): RecordedRegistryWrite[] {
		return this.writes.filter((write) => write.operation === operation);
	}

	public operationOrder(): string[] {
		return this.writes.map((write) => write.operation);
	}

	/** The registry's full contents, normalised so two runs can be compared with one `toEqual`. */
	public state(): RecordedRegistryState {
		return {
			guild: this.guilds.get("guild") ?? null,
			roles: [...this.roles.values()].sort(byId((role) => role.roleId)),
			memberships: [...this.memberships.values()]
				.sort(byId((membership) => membership.userId))
				.map((membership) => ({ ...membership, roleIds: [...membership.roleIds].sort() })),
			channels: [...this.channels.values()].sort(byId((channel) => channel.channelId)),
			overwrites: [...this.overwrites.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([channelId, targets]) => [channelId, [...targets].sort()] as const),
			threadMemberships: [...this.threadMemberships.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([threadId, userIds]) => [threadId, [...userIds].sort()] as const)
		};
	}

	/** Rows a double refuses to write, e.g. a thread whose parent is absent (R6). */
	/** A failed statement rolls its transaction back, so the attempt is recorded and nothing is mutated. */
	public record(operation: string, rows: number): void {
		this.writes.push({ operation, rows, sequence: this.writes.length + 1 });
		if (this.options.failOperation === operation && this.writes.length > (this.options.failAfterWrites ?? 0)) {
			throw new Error(`recording registry failed ${operation} on write ${this.writes.length}`);
		}
	}

	public membershipKey(userId: DiscordIdentifier): string {
		return userId;
	}
}

function byId<T>(id: (value: T) => string): (a: T, b: T) => number {
	return (a, b) => id(a).localeCompare(id(b));
}

class GuildRegistryDouble implements GuildRegistryRepository {
	public constructor(private readonly store: RecordingRegistries) {}

	public readonly upsertGuild = async (guild: RegistryGuild): Promise<RegistryGuild> => {
		this.store.record("upsertGuild", 1);
		this.store.guilds.set("guild", guild);
		return guild;
	};

	public readonly findGuild = async (guildId: DiscordIdentifier): Promise<RegistryGuild | null> =>
		this.store.guilds.get("guild")?.guildId === guildId ? (this.store.guilds.get("guild") ?? null) : null;
}

class RoleRegistryDouble implements RoleRegistryRepository {
	public constructor(private readonly store: RecordingRegistries) {}

	public readonly upsertRoles = async (roles: readonly RegistryRole[]): Promise<RegistryBatchWriteResult> => {
		this.store.record("upsertRoles", roles.length);
		for (const role of roles) {
			this.store.roles.set(role.roleId, role);
		}
		return { rowsWritten: roles.length, batches: 1 };
	};

	public readonly deleteRoleAndDependents = async (
		guildId: DiscordIdentifier,
		roleId: DiscordIdentifier
	): Promise<RegistryRoleRemovalResult> => {
		this.store.record("deleteRoleAndDependents", 1);
		const removed = this.store.roles.delete(roleId);
		let links = 0;
		for (const membership of this.store.memberships.values()) {
			if (!membership.roleIds.includes(roleId)) {
				continue;
			}
			links += 1;
			this.store.memberships.set(membership.userId, {
				...membership,
				roleIds: membership.roleIds.filter((id) => id !== roleId)
			});
		}
		let overwrites = 0;
		for (const [channelId, targets] of this.store.overwrites.entries()) {
			const kept = targets.filter((target) => target !== `role:${roleId}`);
			overwrites += targets.length - kept.length;
			this.store.overwrites.set(channelId, kept);
		}
		return {
			roleRemoved: removed && guildId != null,
			membershipLinksRemoved: links,
			overwritesRemoved: overwrites
		};
	};

	public readonly findRoles = async (guildId: DiscordIdentifier): Promise<readonly RegistryRole[]> =>
		[...this.store.roles.values()].filter((role) => role.guildId === guildId);

	public readonly findRolePermissions = async (
		guildId: DiscordIdentifier,
		roleIds: readonly DiscordIdentifier[]
	): Promise<readonly RegistryRolePermission[]> =>
		[...this.store.roles.values()]
			.filter((role) => role.guildId === guildId && roleIds.includes(role.roleId))
			.map((role) => ({ roleId: role.roleId, permissionsBitfield: role.permissionsBitfield }));
}

class MembershipRegistryDouble implements MembershipRegistryRepository {
	public constructor(private readonly store: RecordingRegistries) {}

	public readonly upsertMemberships = async (
		memberships: readonly RegistryMembership[]
	): Promise<RegistryBatchWriteResult> => {
		this.store.record("upsertMemberships", memberships.length);
		for (const membership of memberships) {
			// R9: the same natural key means the same row, replaced — never a second one.
			this.store.memberships.set(membership.userId, {
				...membership,
				roleIds: [...membership.roleIds].sort()
			});
		}
		return { rowsWritten: memberships.length, batches: 1 };
	};

	public readonly replaceMembershipRoles = async (
		membership: RegistryMembership
	): Promise<RegistryRoleSetReplacementResult> => {
		this.store.record("replaceMembershipRoles", 1);
		const previous = this.store.memberships.get(membership.userId);
		this.store.memberships.set(membership.userId, { ...membership, roleIds: [...membership.roleIds].sort() });
		return {
			roleLinksRemoved: previous?.roleIds.length ?? 0,
			roleLinksWritten: membership.roleIds.length
		};
	};

	public readonly deleteMembershipAndDependents = async (
		guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	): Promise<RegistryMembershipRemovalResult> => {
		this.store.record("deleteMembershipAndDependents", 1);
		const previous = this.store.memberships.get(userId);
		this.store.memberships.delete(userId);
		let overwrites = 0;
		for (const [channelId, targets] of this.store.overwrites.entries()) {
			const kept = targets.filter((target) => target !== `member:${userId}`);
			overwrites += targets.length - kept.length;
			this.store.overwrites.set(channelId, kept);
		}
		let edges = 0;
		for (const [threadId, userIds] of this.store.threadMemberships.entries()) {
			const kept = userIds.filter((id) => id !== userId);
			edges += userIds.length - kept.length;
			this.store.threadMemberships.set(threadId, kept);
		}
		return {
			membershipRemoved: previous !== undefined && guildId != null,
			roleLinksRemoved: previous?.roleIds.length ?? 0,
			overwritesRemoved: overwrites,
			threadMembershipsRemoved: edges
		};
	};

	public readonly findMembership = async (
		guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	): Promise<RegistryMembership | null> => {
		const found = this.store.memberships.get(userId);
		return found !== undefined && found.guildId === guildId ? found : null;
	};

	public readonly findMembershipUserIds = async (guildId: DiscordIdentifier): Promise<readonly DiscordIdentifier[]> =>
		[...this.store.memberships.values()]
			.filter((membership) => membership.guildId === guildId)
			.map((membership) => membership.userId);
}

class ChannelRegistryDouble implements ChannelRegistryRepository {
	public constructor(private readonly store: RecordingRegistries) {}

	public readonly upsertChannels = async (
		channels: readonly RegistryChannel[]
	): Promise<RegistryBatchWriteResult> => {
		this.store.record("upsertChannels", channels.length);
		// The two integrity rules the PostgreSQL adapter enforces on this statement, mirrored (R6):
		// a thread row always names a parent, and a named parent must be a row — in the registry already or in
		// the same batch, which is the one-to-one behaviour of a single multi-row INSERT.
		const batched = new Set(channels.map((channel) => channel.channelId));
		for (const channel of channels) {
			const threadLike = DOUBLE_THREAD_CHANNEL_TYPES.includes(channel.channelType);
			if (threadLike && channel.parentChannelId === null) {
				throw new Error(`channel_thread_has_parent would reject thread ${channel.channelId} (R6)`);
			}
			if (
				channel.parentChannelId !== null &&
				!batched.has(channel.parentChannelId) &&
				this.store.channels.get(channel.parentChannelId) === undefined
			) {
				throw new Error(
					`channel.parent_channel_id foreign key would reject unknown parent ${channel.parentChannelId}`
				);
			}
			this.store.channels.set(channel.channelId, channel);
		}
		return { rowsWritten: channels.length, batches: 1 };
	};

	public readonly deleteChannelAndDependents = async (
		guildId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): Promise<RegistryChannelRemovalResult> => {
		this.store.record("deleteChannelAndDependents", 1);
		const existing = this.store.channels.get(channelId);
		const removed = existing !== undefined && existing.guildId === guildId;
		// R6's cascade, in the same scope the adapter uses: the row, everything parented to it, and their
		// overwrites and thread edges — reported as counts, because a deletion that cannot count itself is not
		// provable.
		const children = [...this.store.channels.values()]
			.filter((channel) => channel.guildId === guildId && channel.parentChannelId === channelId)
			.map((channel) => channel.channelId);
		const affectedIds = [channelId, ...children];
		let overwrites = 0;
		let edges = 0;
		for (const affectedId of affectedIds) {
			overwrites += this.store.overwrites.get(affectedId)?.length ?? 0;
			edges += this.store.threadMemberships.get(affectedId)?.length ?? 0;
			this.store.overwrites.delete(affectedId);
			this.store.overwriteEntries.delete(affectedId);
			this.store.threadMemberships.delete(affectedId);
		}
		for (const child of children) {
			this.store.channels.delete(child);
		}
		if (removed) {
			this.store.channels.delete(channelId);
		}
		return {
			channelRemoved: removed,
			childThreadsRemoved: removed ? children.length : 0,
			overwritesRemoved: removed ? overwrites : 0,
			threadMembershipsRemoved: removed ? edges : 0
		};
	};

	public readonly replaceChannelOverwrites = async (
		set: RegistryChannelOverwriteSet
	): Promise<RegistryOverwriteReplacementResult> => {
		this.store.record("replaceChannelOverwrites", set.overwrites.length);
		const previous = this.store.overwrites.get(set.channelId) ?? [];
		// R7: the new list is the whole set. A target that disappeared is gone, not left behind as a grant.
		this.store.overwrites.set(
			set.channelId,
			set.overwrites.map((overwrite) => `${overwrite.targetType}:${overwrite.targetId}`).sort()
		);
		this.store.overwriteEntries.set(set.channelId, [...set.overwrites]);
		return { overwritesRemoved: previous.length, overwritesWritten: set.overwrites.length };
	};

	public readonly findChannels = async (guildId: DiscordIdentifier): Promise<readonly RegistryChannel[]> =>
		[...this.store.channels.values()].filter((channel) => channel.guildId === guildId);

	public readonly findChannel = async (
		guildId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): Promise<RegistryChannel | null> => {
		const found = this.store.channels.get(channelId);
		return found !== undefined && found.guildId === guildId ? found : null;
	};

	public readonly findChannelOverwrites = async (
		_guildId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): Promise<readonly ChannelPermissionOverwrite[]> => this.store.overwriteEntries.get(channelId) ?? [];
}

class ThreadMembershipRegistryDouble implements ThreadMembershipRegistryRepository {
	public constructor(private readonly store: RecordingRegistries) {}

	public readonly replaceThreadMemberships = async (
		set: RegistryThreadMembershipSet
	): Promise<RegistryThreadMembershipReplacementResult> => {
		this.store.record("replaceThreadMemberships", set.userIds.length);
		const previous = this.store.threadMemberships.get(set.threadId) ?? [];
		// The thread must be in the registry: the real adapter enforces this with a foreign key (R8).
		if (this.store.channels.get(set.threadId) === undefined) {
			throw new Error(`thread_membership.thread_id foreign key would reject unknown thread ${set.threadId}`);
		}
		this.store.threadMemberships.set(set.threadId, [...set.userIds].sort());
		return { membershipsRemoved: previous.length, membershipsWritten: set.userIds.length };
	};

	public readonly addThreadMembership = async (membership: RegistryThreadMembership): Promise<boolean> => {
		this.store.record("addThreadMembership", 1);
		// The composite foreign key the adapter carries: an edge needs a thread row, and one from another Guild
		// is not that row (R8, R1). An unknown thread is therefore refused here rather than silently accepted.
		if (this.store.channels.get(membership.threadId)?.guildId !== membership.guildId) {
			throw new Error(
				`thread_membership.thread_id foreign key would reject unknown thread ${membership.threadId} (R8)`
			);
		}
		const current = this.store.threadMemberships.get(membership.threadId) ?? [];
		if (current.includes(membership.userId)) {
			return false;
		}
		this.store.threadMemberships.set(membership.threadId, [...current, membership.userId]);
		return true;
	};

	public readonly removeThreadMembership = async (membership: RegistryThreadMembership): Promise<boolean> => {
		this.store.record("removeThreadMembership", 1);
		const current = this.store.threadMemberships.get(membership.threadId) ?? [];
		const kept = current.filter((id) => id !== membership.userId);
		this.store.threadMemberships.set(membership.threadId, kept);
		return kept.length !== current.length;
	};

	public readonly findThreadMemberUserIds = async (
		_guildId: DiscordIdentifier,
		threadId: DiscordIdentifier
	): Promise<readonly DiscordIdentifier[]> => this.store.threadMemberships.get(threadId) ?? [];

	public readonly findThreadIdsForMember = async (
		_guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	): Promise<readonly DiscordIdentifier[]> =>
		[...this.store.threadMemberships.entries()]
			.filter(([, userIds]) => userIds.includes(userId))
			.map(([threadId]) => threadId);
}
