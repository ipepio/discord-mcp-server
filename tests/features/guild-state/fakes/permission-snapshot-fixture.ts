import type { DiscordIdentifier } from "../../../../src/features/guild-state/models/domain/discord-identifier.js";
import type {
	RegistryChannel,
	RegistryChannelOverwrite,
	RegistryMembership,
	RegistryPermissionSnapshot,
	RegistryRolePermission
} from "../../../../src/features/guild-state/models/domain/registry-records.js";
import type {
	PermissionSnapshotRepository,
	PermissionSnapshotRequest
} from "../../../../src/features/guild-state/repositories/permission-snapshot.repository.js";

/**
 * The evaluation's read-model test double and the builders that fill it (docs/features/guild-state.md R12,
 * R13; docs/architecture/testing.md: "Mock repository/gateway contracts for use-case tests, not their
 * implementation internals"). A use case is tested against the *contract* — one snapshot per call — so the
 * state that drives a decision is written here as data, and the fake records the requests it received so a
 * test can prove the bounded read happened exactly the way the spec states it: one call, wide form for a
 * list, narrow form for a decision.
 */

export interface SnapshotBuildOptions {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	/** `@everyone`'s stored bitfield, or null for "the role row is absent" (R3). Default: "0". */
	readonly everyone?: string | null;
	/** The membership row, or null for "not a member" (R4). Default: a member with no roles. */
	readonly membership?: RegistryMembership | null;
	readonly roles?: readonly RegistryRolePermission[];
	readonly channels?: readonly RegistryChannel[];
	/** Overwrite rows grouped by the channel they belong to, in Discord's target vocabulary (R7). */
	readonly overwrites?: readonly (readonly [DiscordIdentifier, readonly RegistryChannelOverwrite[]])[];
	/** The private threads the registry holds a membership edge for (R8). */
	readonly privateThreadIds?: readonly DiscordIdentifier[];
	/** false leaves the Guild row out, which is the never-bootstrapped state (R2). Default: true. */
	readonly guildRegistered?: boolean;
}

export function channelRow(
	guildId: DiscordIdentifier,
	channelId: DiscordIdentifier,
	channelType: RegistryChannel["channelType"] = "guild-text",
	parentChannelId: DiscordIdentifier | null = null
): RegistryChannel {
	return { guildId, channelId, channelType, name: null, position: null, parentChannelId };
}

export function overwriteRow(
	targetId: DiscordIdentifier,
	targetType: RegistryChannelOverwrite["targetType"],
	allow: bigint | string = 0n,
	deny: bigint | string = 0n
): RegistryChannelOverwrite {
	return {
		targetId,
		targetType,
		allowBitfield: typeof allow === "bigint" ? allow.toString() : allow,
		denyBitfield: typeof deny === "bigint" ? deny.toString() : deny
	};
}

export function roleRow(roleId: DiscordIdentifier, permissionsBitfield: string): RegistryRolePermission {
	return { roleId, permissionsBitfield };
}

export function membershipRow(
	guildId: DiscordIdentifier,
	userId: DiscordIdentifier,
	roleIds: readonly DiscordIdentifier[] = []
): RegistryMembership {
	return { guildId, userId, roleIds };
}

export function snapshotFixture(options: SnapshotBuildOptions): RegistryPermissionSnapshot {
	const channels = options.channels ?? [channelRow(options.guildId, DEFAULT_CHANNEL_ID)];
	const groups = options.overwrites ?? [];
	return {
		guild: options.guildRegistered === false ? null : { guildId: options.guildId, guildName: "Test guild" },
		membership:
			options.membership === undefined ? membershipRow(options.guildId, options.userId) : options.membership,
		everyonePermissions: options.everyone === undefined ? "0" : options.everyone,
		rolePermissions: options.roles ?? [],
		channels,
		overwriteSets: channels.map((candidate) => ({
			guildId: options.guildId,
			channelId: candidate.channelId,
			overwrites: groups.find(([channelId]) => channelId === candidate.channelId)?.[1] ?? []
		})),
		privateThreadIds: options.privateThreadIds ?? []
	};
}

const DEFAULT_CHANNEL_ID: DiscordIdentifier = "160000000000000201";

/** The double: one canned snapshot per request, every request recorded, and an optional failure to throw. */
export class FakePermissionSnapshotRepository implements PermissionSnapshotRepository {
	public readonly requests: PermissionSnapshotRequest[] = [];

	/** Answers handed out before `state.snapshot` is: the before/after pair one command reads in order. */
	private readonly queued: RegistryPermissionSnapshot[] = [];

	public constructor(private state: { snapshot: RegistryPermissionSnapshot; failure?: unknown }) {}

	/** The fake has no write method, which is R13's proof by shape: nothing here can change stored state. */
	public readonly loadSnapshot = async (request: PermissionSnapshotRequest): Promise<RegistryPermissionSnapshot> => {
		this.requests.push(request);
		if (this.state.failure !== undefined) {
			throw this.state.failure;
		}
		return this.queued.shift() ?? this.state.snapshot;
	};

	/**
	 * Program the answers one call sequence reads, in order. A command that evaluates before and after a write
	 * asks the same snapshot contract twice, so the state it sees second is not the state it saw first.
	 */
	public queueSnapshots(snapshots: readonly RegistryPermissionSnapshot[]): void {
		this.queued.push(...snapshots);
	}

	public setSnapshot(snapshot: RegistryPermissionSnapshot): void {
		this.state = { snapshot, ...(this.state.failure === undefined ? {} : { failure: this.state.failure }) };
	}

	public failNext(failure: unknown): void {
		this.state = { snapshot: this.state.snapshot, failure };
	}

	public clearFailure(): void {
		this.state = { snapshot: this.state.snapshot };
	}

	/** The requests narrowed to the wide (list) form, which is the one bounded pass the spec requires. */
	public wideRequests(): PermissionSnapshotRequest[] {
		return this.requests.filter((request) => request.channelId === null);
	}
}
