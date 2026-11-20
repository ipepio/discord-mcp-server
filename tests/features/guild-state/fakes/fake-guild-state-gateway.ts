import type {
	DiscordChannelRecord,
	DiscordGuildSnapshot,
	DiscordMemberRecord,
	DiscordMemberRoster,
	DiscordRoleRecord,
	DiscordThreadMemberPage
} from "../../../../src/features/discord/index.js";
import { DiscordRestFailureError } from "../../../../src/features/discord/index.js";
import type { DiscordRestFailureDetails } from "../../../../src/features/discord/index.js";
import type { GuildStateGateway } from "../../../../src/features/guild-state/gateways/guild-state-gateway.interface.js";

/**
 * The `GuildStateGateway` test double: programmed answers, plus a full record of which read was asked for
 * and with what bound. The bootstrap's promises are about *sequence and completeness* — which parts were
 * read, how many times, and what happened when a read failed — so the double has to be able to fail one
 * specific read with one specific boundary reason, and to report a roster as truncated.
 *
 * Failures are thrown as the real `DiscordRestFailureError`, because the command's behaviour depends on that
 * boundary's own reason classification (docs/features/discord.md R7): a `"not-found"` on the Guild read and a
 * `"server-error"` on it are different outcomes under R2, and faking the error shape would let a test pass
 * against a failure the real adapter can never produce.
 */

/** One read the fake can be told to fail, and the reason it fails with. */
export type FailingRead = "guild" | "roles" | "channels" | "roster" | "threadMembers";

/**
 * The answers the fake gives. Its own properties are writable on purpose: the fake reads the program lazily,
 * so a case re-programs one read to say "this is what Discord reports next" — the mid-test outage in
 * `resync-guild-state.command.test.ts` is exactly that. The values stay the production record types, so no
 * nested field of a snapshot, role, channel or member can be edited anywhere.
 */
export interface FakeGatewayProgram {
	snapshot?: DiscordGuildSnapshot;
	roles?: readonly DiscordRoleRecord[];
	channels?: readonly DiscordChannelRecord[];
	roster?: DiscordMemberRoster;
	/** Per thread: the pages the read returns in order. An absent thread id fails as `unauthorized`. */
	threadMembers?: Readonly<Record<string, readonly DiscordThreadMemberPage[]>>;
	/** Reads that throw instead of answering, keyed by the read's own name. */
	failures?: Partial<Readonly<Record<FailingRead, DiscordRestFailureProgram>>>;
}

export interface DiscordRestFailureProgram {
	readonly reason: DiscordRestFailureDetails["reason"];
	readonly status?: number;
	readonly operation?: DiscordRestFailureDetails["operation"];
	/** Applies to the first N calls only (0 = every call). Lets a test fail a read once, then succeed. */
	readonly times?: number;
}

export interface RecordedGatewayCall {
	readonly read: FailingRead;
	/** The argument the read was called with, when it had one. */
	readonly detail: string;
}

export class FakeGuildStateGateway implements GuildStateGateway {
	public readonly calls: RecordedGatewayCall[] = [];

	private readonly failuresRemaining: Record<FailingRead, number>;

	private readonly threadCursor = new Map<string, number>();

	public constructor(
		private readonly program: FakeGatewayProgram,
		private readonly guildId: string
	) {
		this.failuresRemaining = {
			guild: failingTimes(program, "guild"),
			roles: failingTimes(program, "roles"),
			channels: failingTimes(program, "channels"),
			roster: failingTimes(program, "roster"),
			threadMembers: failingTimes(program, "threadMembers")
		};
	}

	/** Every read name this gateway was asked for, in call order. */
	public readNames(): FailingRead[] {
		return this.calls.map((call) => call.read);
	}

	public countOf(read: FailingRead): number {
		return this.calls.filter((call) => call.read === read).length;
	}

	public readonly readGuildSnapshot = async (): Promise<DiscordGuildSnapshot> => {
		this.record("guild", "with_counts");
		this.throwIfFailing("guild");
		return this.program.snapshot ?? defaultSnapshot(this.guildId);
	};

	public readonly readRoles = async (): Promise<readonly DiscordRoleRecord[]> => {
		this.record("roles", "all");
		this.throwIfFailing("roles");
		return this.program.roles ?? [];
	};

	public readonly readChannels = async (): Promise<readonly DiscordChannelRecord[]> => {
		this.record("channels", "all");
		this.throwIfFailing("channels");
		return this.program.channels ?? [];
	};

	public readonly readMemberRoster = async (read?: Parameters<GuildStateGateway["readMemberRoster"]>[0]) => {
		const maxPages = read?.maxPages ?? "policy-default";
		this.record("roster", `maxPages=${String(maxPages)}`);
		this.throwIfFailing("roster");
		return this.program.roster ?? completeRoster(this.guildId, []);
	};

	/**
	 * A thread the program did not list is `unauthorized` — that is what R8's coverage limit looks like from
	 * here, and the reason the command must never invent a member set for it.
	 */
	public readonly readThreadMembers = async (
		read: Parameters<GuildStateGateway["readThreadMembers"]>[0]
	): Promise<DiscordThreadMemberPage> => {
		this.record("threadMembers", `${read.threadId}${read.after === undefined ? "" : ` after=${read.after}`}`);
		const pages = this.program.threadMembers?.[read.threadId];
		if (pages === undefined) {
			throw restFailure({ reason: "unauthorized", status: 403, operation: "discord-rest.thread-members" });
		}
		this.throwIfFailing("threadMembers");

		const index = this.threadCursor.get(read.threadId) ?? 0;
		this.threadCursor.set(read.threadId, index + 1);
		const page = pages[index];
		if (page === undefined) {
			// The program ran out of pages: answer as an empty final page rather than inventing one.
			return { threadId: read.threadId, members: [], requestedLimit: 100, hasMore: false };
		}
		return page;
	};

	private record(read: FailingRead, detail: string): void {
		this.calls.push({ read, detail });
	}

	private throwIfFailing(read: FailingRead): void {
		const program = this.program.failures?.[read];
		if (program === undefined || this.failuresRemaining[read] <= 0) {
			return;
		}
		this.failuresRemaining[read] -= 1;
		throw restFailure({ ...program, operation: program.operation ?? defaultOperationFor(read) });
	}
}

function restFailure(details: {
	reason: DiscordRestFailureDetails["reason"];
	status?: number;
	operation: DiscordRestFailureDetails["operation"];
}): DiscordRestFailureError {
	return new DiscordRestFailureError({
		operation: details.operation,
		reason: details.reason,
		attempts: 3,
		detail: `programmed ${details.reason}`,
		...(details.status === undefined ? {} : { status: details.status })
	});
}

function failingTimes(program: FakeGatewayProgram, read: FailingRead): number {
	const failure = program.failures?.[read];
	if (failure === undefined) {
		return 0;
	}
	return failure.times ?? Number.MAX_SAFE_INTEGER;
}

function defaultOperationFor(read: FailingRead): DiscordRestFailureDetails["operation"] {
	switch (read) {
		case "guild":
			return "discord-rest.guild-snapshot";
		case "roles":
			return "discord-rest.roles";
		case "channels":
			return "discord-rest.channels";
		case "roster":
			return "discord-rest.member-roster";
		case "threadMembers":
			return "discord-rest.thread-members";
	}
}

/** The fixture helpers: the shapes the discord adapter really returns, built from the configured Guild. */

export function defaultSnapshot(guildId: string, name = "Example Guild HQ"): DiscordGuildSnapshot {
	return { guildId, name };
}

export function role(guildId: string, roleId: string, permissionsBitfield = "0", position = 0): DiscordRoleRecord {
	return { guildId, roleId, name: `role-${roleId}`, permissionsBitfield, position };
}

export function channel(
	guildId: string,
	channelId: string,
	overrides: Partial<Omit<DiscordChannelRecord, "guildId" | "channelId">> = {}
): DiscordChannelRecord {
	return { guildId, channelId, channelType: "guild-text", ...overrides };
}

export function thread(
	guildId: string,
	channelId: string,
	parentId: string,
	channelType: DiscordChannelRecord["channelType"] = "private-thread",
	overrides: Partial<Omit<DiscordChannelRecord, "guildId" | "channelId" | "channelType" | "parentId">> = {}
): DiscordChannelRecord {
	return { guildId, channelId, channelType, parentId, ...overrides };
}

export function member(
	guildId: string,
	userId: string,
	roleIds: readonly string[] = [],
	extra: Partial<Pick<DiscordMemberRecord, "username" | "nickname">> = {}
): DiscordMemberRecord {
	// Display data is offered by the read on purpose: a test asserts the registry never keeps it (R14, O2).
	return { guildId, userId, roleIds, ...extra };
}

export function completeRoster(
	guildId: string,
	members: readonly DiscordMemberRecord[],
	pages = 1
): DiscordMemberRoster {
	return { guildId, members, pages, complete: true };
}

export function truncatedRoster(
	guildId: string,
	members: readonly DiscordMemberRecord[],
	pages: number,
	truncatedBy: "page-limit" | "member-limit"
): DiscordMemberRoster {
	return { guildId, members, pages, complete: false, truncatedBy };
}

export function threadPage(
	threadId: string,
	userIds: readonly string[],
	hasMore = false,
	nextAfterId?: string
): DiscordThreadMemberPage {
	return {
		threadId,
		members: userIds.map((userId) => ({ threadId, userId })),
		requestedLimit: 100,
		hasMore,
		...(nextAfterId === undefined ? {} : { nextAfterId })
	};
}
