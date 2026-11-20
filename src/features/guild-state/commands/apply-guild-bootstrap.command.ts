import { DiscordRestFailureError } from "../../discord/index.js";
import type {
	DiscordChannelRecord,
	DiscordMemberRecord,
	DiscordRestFailureReason,
	DiscordRoleRecord
} from "../../discord/index.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { GuildStateGateway } from "../gateways/guild-state-gateway.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { GuildBootstrapFailureReason } from "../models/domain/bootstrap.errors.js";
import { GuildBootstrapGuildMismatchError, GuildBootstrapUnavailableError } from "../models/domain/bootstrap.errors.js";
import type {
	GuildBootstrapGap,
	GuildBootstrapPart,
	GuildBootstrapPartReport,
	GuildBootstrapReport,
	GuildBootstrapStateTracker
} from "../models/domain/bootstrap-state.js";
import { GUILD_BOOTSTRAP_PARTS, isGuildAccessLostReason } from "../models/domain/bootstrap-state.js";
import type {
	RegistryChannel,
	RegistryMembership,
	RegistryRole,
	RegistryThreadMembershipSet
} from "../models/domain/registry-records.js";
import { isThreadChannelType } from "../models/domain/registry-rules.js";
import type { VanishedStateReadSets } from "../models/domain/vanished-state.js";
import type { ChannelRegistryRepository } from "../repositories/channel-registry.repository.js";
import type { GuildRegistryRepository } from "../repositories/guild-registry.repository.js";
import type { MembershipRegistryRepository } from "../repositories/membership-registry.repository.js";
import type { RoleRegistryRepository } from "../repositories/role-registry.repository.js";
import type { ThreadMembershipRegistryRepository } from "../repositories/thread-membership-registry.repository.js";

/**
 * The REST bootstrap pass (docs/features/guild-state.md R2): the Guild row, the role list, the channels and
 * threads with their overwrite sets, the paginated member roster, and thread membership where the API allows
 * that read — each part applied through the registry repositories in the bounded batch transactions those
 * repositories already declare (`repositories/registry-write-batch.ts`), and each part recorded as applied
 * only after its writes returned.
 *
 * Resumability, the half this command can promise (the decision recorded in `odd/tasks/guild-state.md` T2):
 *
 * - Inside one process a pass applies only the parts the tracker still reports pending, so a second pass
 *   after a failed one costs the missing reads and nothing else.
 * - Across a process restart the tracker is empty by construction, so every part is pending again and the
 *   whole path re-runs. That is safe rather than merely tolerated: every write below is an upsert or a
 *   wholesale replacement keyed on Discord's own ids, so re-applying the same REST data changes nothing
 *   observable (R9). The rows are the durable state; the tracker only records what this process has seen.
 *
 * What stops a pass, and how, is R2's other half:
 *
 * - A lost Guild — a 4xx on the Guild read, or Discord reporting the configured Guild unavailable — throws
 *   {@link GuildBootstrapUnavailableError} before anything is applied, so the bootstrap can never degrade
 *   into an empty-but-"complete" registry, and no other part is attempted.
 * - A transient technical failure (429, 5xx, timeout, transport, validation) is surfaced as it arrived: the
 *   `discord` REST adapter already spent its own bounded retries with backoff inside the call
 *   (docs/features/discord.md R7), so retrying here would double that budget and hide which read stopped the
 *   pass. The part stays pending; parts already applied stay applied.
 * - A part the provider cannot answer fully — a roster that stopped at its page bound, a thread whose member
 *   list this Installation may not read — is recorded as a gap, leaves that part pending, and returns
 *   normally so a later pass can complete it. `report.complete` is the tracker's answer, never this command's
 *   optimism (R2: completion is never claimed while any part is pending).
 *
 * No transaction spans a Discord REST call (spec Contracts): every read finishes before the repository call
 * that follows it opens a transaction, and the repositories commit per bounded batch.
 */

/**
 * How far one thread's member list is walked in one pass. The adapter clamps the page size to Discord's own
 * ceiling, so this is the pagination bound this feature declares: a thread with more members than this stays
 * pending as a recorded gap rather than being reported as fully read.
 */
const MAX_THREAD_MEMBER_PAGES = 20;

/**
 * One part's outcome in this pass: what it wrote, whether it finished, why not when it did not, and the whole
 * set it read. The last field is what makes R11's convergence sweep possible without a second REST read: the
 * pass already holds the provider's answer about each set, so it reports the ids rather than making the resync
 * ask again (bounded read budget, one source of truth about what was read).
 */
interface PartOutcome {
	readonly rowsWritten: number;
	readonly applied: boolean;
	readonly gap?: GuildBootstrapGap;
	/** Absent when no read finished in this part: a skipped or failed part reports no set, so nothing is swept. */
	readonly read?: VanishedStateReadSets;
}

/** One thread's member list as far as it could be read. `complete` false means the set below is not the set. */
interface ThreadMemberSetRead {
	readonly userIds: readonly DiscordIdentifier[];
	readonly complete: boolean;
}

export interface ApplyGuildBootstrapCommandDependencies {
	readonly config: GuildStateConfig;
	readonly gateway: GuildStateGateway;
	readonly tracker: GuildBootstrapStateTracker;
	readonly guildRegistry: GuildRegistryRepository;
	readonly roleRegistry: RoleRegistryRepository;
	readonly channelRegistry: ChannelRegistryRepository;
	readonly membershipRegistry: MembershipRegistryRepository;
	readonly threadMembershipRegistry: ThreadMembershipRegistryRepository;
	readonly logger: AppLogger;
}

export class ApplyGuildBootstrapCommand {
	private readonly gateway: GuildStateGateway;

	private readonly guildRegistry: GuildRegistryRepository;

	private readonly roleRegistry: RoleRegistryRepository;

	private readonly channelRegistry: ChannelRegistryRepository;

	private readonly membershipRegistry: MembershipRegistryRepository;

	private readonly threadMembershipRegistry: ThreadMembershipRegistryRepository;

	private readonly tracker: GuildBootstrapStateTracker;

	private readonly guildId: DiscordIdentifier;

	/** The bound this Installation declared for one roster pass; the adapter's own policy caps it too. */
	private readonly rosterMaxPages: number;

	private readonly logger: AppLogger;

	public constructor(deps: ApplyGuildBootstrapCommandDependencies) {
		this.gateway = deps.gateway;
		this.guildRegistry = deps.guildRegistry;
		this.roleRegistry = deps.roleRegistry;
		this.channelRegistry = deps.channelRegistry;
		this.membershipRegistry = deps.membershipRegistry;
		this.threadMembershipRegistry = deps.threadMembershipRegistry;
		this.tracker = deps.tracker;
		this.guildId = deps.config.guildId;
		this.rosterMaxPages = deps.config.bootstrap.rosterMaxPages;
		this.logger = deps.logger;
	}

	/**
	 * One bootstrap pass over the parts still pending. R2's "an empty registry and a registry flagged stale
	 * both take the same bootstrap path" needs no branch here: with nothing stored every part is pending, and
	 * with rows already stored the same writes simply re-confirm them (R9) and change nothing.
	 */
	public readonly execute = async (): Promise<GuildBootstrapReport> => {
		const parts: GuildBootstrapPartReport[] = [];
		const gaps: GuildBootstrapGap[] = [];
		// The sets this pass read, merged part by part. A part the tracker already held applied contributes nothing,
		// because this pass did not read it.
		let reads: VanishedStateReadSets = {};

		for (const part of GUILD_BOOTSTRAP_PARTS) {
			if (this.tracker.isApplied(part)) {
				this.logger.debug("guild-state bootstrap part already applied in this process", {
					guildId: this.guildId,
					part
				});
				parts.push({ part, state: "applied", rowsWritten: 0 });
				continue;
			}

			const outcome = await this.applyPart(part);
			if (outcome.applied) {
				this.tracker.markApplied(part);
			}
			reads = { ...reads, ...outcome.read };

			if (outcome.gap !== undefined) {
				gaps.push(outcome.gap);
				this.logger.warn("guild-state bootstrap part left pending", {
					guildId: this.guildId,
					part: outcome.gap.part,
					reason: outcome.gap.reason,
					...(outcome.gap.threadIds === undefined ? {} : { threadCount: outcome.gap.threadIds.length })
				});
			}

			parts.push({ part, state: outcome.applied ? "applied" : "pending", rowsWritten: outcome.rowsWritten });
		}

		const report: GuildBootstrapReport = {
			guildId: this.guildId,
			complete: this.tracker.isComplete(),
			parts,
			gaps,
			reads
		};

		this.logger.info("guild-state bootstrap pass finished", {
			guildId: this.guildId,
			complete: report.complete,
			appliedParts: parts.filter((entry) => entry.state === "applied").length,
			pendingParts: parts.filter((entry) => entry.state === "pending").length,
			gapCount: gaps.length
		});

		return report;
	};

	private async applyPart(part: GuildBootstrapPart): Promise<PartOutcome> {
		switch (part) {
			case "guild":
				return this.applyGuildPart();
			case "roles":
				return this.applyRolesPart();
			case "channels":
				return this.applyChannelsPart();
			case "roster":
				return this.applyRosterPart();
			case "thread-members":
				return this.applyThreadMembersPart();
		}
	}

	/**
	 * R2's Guild row, and the only part that can end the whole pass: a lost Guild is not a pending part, it is
	 * a registry that must never be consumed as authoritative. The other parts are not attempted when this one
	 * fails, because their reads cannot be trusted to describe a Guild this Installation can no longer see.
	 */
	private async applyGuildPart(): Promise<PartOutcome> {
		let snapshot;
		try {
			snapshot = await this.gateway.readGuildSnapshot();
		} catch (failure) {
			throw this.failOnGuildRead("readGuildSnapshot", failure);
		}

		if (snapshot.isUnavailable === true) {
			// R1's boundary case: the bot left the configured Guild. Recovery is operator action, not a fallback.
			this.logger.error("guild-state bootstrap stopped: the configured guild is unavailable", {
				guildId: this.guildId,
				reason: "guild-unavailable"
			});
			throw new GuildBootstrapUnavailableError(this.guildId, "guild-unavailable");
		}

		this.requireConfiguredGuild("readGuildSnapshot", snapshot.guildId);
		await this.guildRegistry.upsertGuild({ guildId: this.guildId, guildName: snapshot.name });
		return { rowsWritten: 1, applied: true };
	}

	/** R3: the whole role list, `@everyone` included, as one bounded batch write. Bitfields stay text (R3). */
	private async applyRolesPart(): Promise<PartOutcome> {
		let roles: readonly DiscordRoleRecord[];
		try {
			roles = await this.gateway.readRoles();
		} catch (failure) {
			throw this.failOnPart("roles", "readRoles", failure);
		}

		const written = await this.roleRegistry.upsertRoles(roles.map((role) => this.toRegistryRole(role)));
		// R3's role read is one unpaginated call: the ids below are the whole set, which is what lets a resync
		// sweep the roles Discord no longer reports.
		return { rowsWritten: written.rowsWritten, applied: true, read: { roles: roles.map((role) => role.roleId) } };
	}

	/**
	 * R6 and R7: channels and threads through one registry write — parents before threads, which the
	 * repository orders — then each channel's overwrite set replaced wholesale.
	 *
	 * Absent is not empty (R10): a channel object that carried no overwrite list is left exactly as stored,
	 * because replacing it with an empty set would delete grants Discord never said were gone. Only a list
	 * that arrived, including an explicitly empty one, is applied as the whole set. A set reported partially is
	 * completed by the targeted REST read path (R10/R11), which is a resync concern, not an invention here.
	 */
	private async applyChannelsPart(): Promise<PartOutcome> {
		let channels: readonly DiscordChannelRecord[];
		try {
			channels = await this.gateway.readChannels();
		} catch (failure) {
			throw this.failOnPart("channels", "readChannels", failure);
		}

		const written = await this.channelRegistry.upsertChannels(
			channels.map((channel) => this.toRegistryChannel(channel))
		);

		let overwriteRows = 0;
		for (const channel of channels) {
			if (channel.permissionOverwrites === undefined) {
				continue;
			}
			const replaced = await this.channelRegistry.replaceChannelOverwrites({
				guildId: this.guildId,
				channelId: channel.channelId,
				overwrites: channel.permissionOverwrites
			});
			overwriteRows += replaced.overwritesWritten;
		}

		return {
			rowsWritten: written.rowsWritten + overwriteRows,
			applied: true,
			// Threads are in this list too, so a thread deleted during the outage is a swept row (R6, R11).
			read: { channels: channels.map((channel) => channel.channelId) }
		};
	}

	/**
	 * R2's paginated roster. A roster that stopped at a bound is a partial read, and a partial read never
	 * completes the part it describes: the members that did arrive are written (they are authoritative for
	 * those rows, R10), the part stays pending, and the gap names the bound so the composition can raise it —
	 * see `GuildBootstrapBounds.rosterMaxPages`, which is where this ceiling is declared.
	 */
	private async applyRosterPart(): Promise<PartOutcome> {
		let roster;
		try {
			roster = await this.gateway.readMemberRoster({ maxPages: this.rosterMaxPages });
		} catch (failure) {
			throw this.failOnPart("roster", "readMemberRoster", failure);
		}

		const memberships = roster.members.map((member) => this.toRegistryMembership(member));
		const written = await this.membershipRegistry.upsertMemberships(memberships);
		// The bound travels with the ids: `complete: false` says the set below is not the roster, and a sweep
		// that read that flag would be a mass revocation (R2's bound, R11's safety rule).
		const read: VanishedStateReadSets = {
			roster: { complete: roster.complete, userIds: roster.members.map((member) => member.userId) }
		};
		if (roster.complete) {
			return { rowsWritten: written.rowsWritten, applied: true, read };
		}

		return {
			rowsWritten: written.rowsWritten,
			applied: false,
			read,
			gap: {
				part: "roster",
				reason: `the roster stopped early (${roster.truncatedBy ?? "no bound reported"}) after ${roster.pages} page(s)`
			}
		};
	}

	/**
	 * R8's private-thread membership, reconciled from REST for the threads this registry already holds — which
	 * is why it reads the *stored* channel list rather than this pass's read result: in a resumed pass the
	 * channels part is already applied and skipped, and the registry stays the one source of "which threads
	 * exist".
	 *
	 * The coverage limit is stated, not hidden (R8 boundary, open decision O1): a thread whose member list this
	 * Installation may not read, or whose list ran past the page bound, is recorded as a gap and the part stays
	 * pending. Nothing is invented to close the gap, and an empty set is stored only when the API answered with
	 * one — "not readable" and "no members" are different facts.
	 */
	private async applyThreadMembersPart(): Promise<PartOutcome> {
		const stored = await this.channelRegistry.findChannels(this.guildId);
		const threadIds = stored
			.filter((channel) => isThreadChannelType(channel.channelType))
			.map((channel) => channel.channelId);
		if (threadIds.length === 0) {
			return { rowsWritten: 0, applied: true };
		}

		const uncoveredThreadIds: DiscordIdentifier[] = [];
		const sets: RegistryThreadMembershipSet[] = [];

		for (const threadId of threadIds) {
			const read = await this.readThreadMemberSet(threadId);
			if (!read.complete) {
				uncoveredThreadIds.push(threadId);
				continue;
			}
			sets.push({ guildId: this.guildId, threadId, userIds: read.userIds });
		}

		let rowsWritten = 0;
		for (const set of sets) {
			const replaced = await this.threadMembershipRegistry.replaceThreadMemberships(set);
			rowsWritten += replaced.membershipsWritten;
		}

		if (uncoveredThreadIds.length === 0) {
			return { rowsWritten, applied: true };
		}

		return {
			rowsWritten,
			applied: false,
			gap: {
				part: "thread-members",
				reason: `${uncoveredThreadIds.length} thread(s) had no readable or complete member list`,
				threadIds: uncoveredThreadIds
			}
		};
	}

	/**
	 * One thread's whole member list, bounded. An access-lost read (4xx) is R8's documented coverage limit and
	 * returns "not complete" rather than an empty set; any other boundary failure keeps its own behaviour,
	 * which for a transient failure means the pass stops with the part pending.
	 */
	private async readThreadMemberSet(threadId: DiscordIdentifier): Promise<ThreadMemberSetRead> {
		const userIds: DiscordIdentifier[] = [];
		let after: string | undefined;

		for (let page = 0; page < MAX_THREAD_MEMBER_PAGES; page += 1) {
			let read;
			try {
				read = await this.gateway.readThreadMembers(after === undefined ? { threadId } : { threadId, after });
			} catch (failure) {
				if (failure instanceof DiscordRestFailureError && isGuildAccessLostReason(failure.reason)) {
					this.logger.warn("guild-state bootstrap could not read this thread's members", {
						guildId: this.guildId,
						threadId,
						reason: failure.reason,
						status: failure.status ?? null
					});
					return { userIds, complete: false };
				}
				throw this.failOnPart("thread-members", "readThreadMembers", failure);
			}

			userIds.push(...read.members.map((member) => member.userId));
			if (!read.hasMore) {
				return { userIds, complete: true };
			}

			after = read.nextAfterId ?? read.members[read.members.length - 1]?.userId;
			if (after === undefined) {
				// Another page was promised but no cursor came with it: the set so far is not the whole set.
				return { userIds, complete: false };
			}
		}

		this.logger.warn("guild-state bootstrap thread member read stopped at its page bound", {
			guildId: this.guildId,
			threadId,
			maxPages: MAX_THREAD_MEMBER_PAGES
		});
		return { userIds, complete: false };
	}

	/* ------------------------------------------------------------------ failures */

	/**
	 * R2's error case, named. A 4xx on the Guild read means this Installation may not read that Guild any
	 * more, so it becomes {@link GuildBootstrapUnavailableError} and stops the pass — the one failure that
	 * must not be softened into "no rows, but done". Every other boundary failure is rethrown as it arrived:
	 * the adapter's retries are already spent, and the tracker keeps the part pending.
	 */
	private failOnGuildRead(operation: string, failure: unknown): Error {
		if (failure instanceof DiscordRestFailureError && isGuildAccessLostReason(failure.reason)) {
			this.logger.error("guild-state bootstrap stopped: the guild read failed with a client error", {
				guildId: this.guildId,
				operation,
				reason: failure.reason,
				status: failure.status ?? null,
				attempts: failure.attempts
			});
			return new GuildBootstrapUnavailableError(this.guildId, failure.reason, failure.status);
		}

		this.logFailure("guild-state bootstrap stopped on a guild read failure", operation, failure);
		return toError(failure);
	}

	/**
	 * The part failed and stays pending. Logged with the part, the read and the boundary's own reason — ids,
	 * counts and a short technical detail, never a payload (R14) — and the failure keeps travelling so the
	 * caller can tell a lost Guild from a busy one.
	 */
	private failOnPart(part: GuildBootstrapPart, operation: string, failure: unknown): Error {
		this.logger.error("guild-state bootstrap part failed; it stays pending for the next pass", {
			guildId: this.guildId,
			part,
			operation,
			reason: restReasonOf(failure),
			detail: describeFailure(failure)
		});
		return toError(failure);
	}

	private logFailure(message: string, operation: string, failure: unknown): void {
		this.logger.error(message, {
			guildId: this.guildId,
			operation,
			reason: restReasonOf(failure),
			detail: describeFailure(failure)
		});
	}

	/**
	 * R1 at the read boundary. A guild-scoped REST read cannot return another Guild's data — the adapter is
	 * constructed with the configured Guild — so a result that names a different one is a broken composition
	 * or a broken payload. The pass stops on a named error instead of storing rows under a Guild that did not
	 * send them, and instead of dropping them as if the registry were simply empty.
	 */
	private requireConfiguredGuild(operation: string, readGuildId: DiscordIdentifier): void {
		if (readGuildId !== this.guildId) {
			this.logger.error("guild-state bootstrap refused a guild read that named another guild", {
				guildId: this.guildId,
				operation,
				resultGuildId: readGuildId
			});
			throw new GuildBootstrapGuildMismatchError(this.guildId, readGuildId);
		}
	}

	/* --------------------------------------------------------------------- mappers */

	/**
	 * The three read-result → registry-record mappers below are the whole of what this feature takes from a
	 * REST result: the configured Guild id (checked, R1), the resource ids, and the fields the registry stores.
	 * Everything else a result offers — a username, a nickname, a join instant, `isManaged` — is dropped here
	 * rather than stored, because R14 and open decision O2 keep the registry id-only.
	 */

	private toRegistryRole(role: DiscordRoleRecord): RegistryRole {
		this.requireSameGuild("readRoles", role.guildId);
		return {
			guildId: this.guildId,
			roleId: role.roleId,
			roleName: role.name,
			// Discord's text verbatim, never a number: a bitfield can exceed the safe-integer range (R3).
			permissionsBitfield: role.permissionsBitfield,
			position: role.position
		};
	}

	private toRegistryChannel(channel: DiscordChannelRecord): RegistryChannel {
		this.requireSameGuild("readChannels", channel.guildId);
		return {
			guildId: this.guildId,
			channelId: channel.channelId,
			channelType: channel.channelType,
			// A name or a position Discord did not send is `null`, not `""` and not `0` (absent is never empty).
			name: channel.name ?? null,
			position: channel.position ?? null,
			parentChannelId: channel.parentId ?? null
		};
	}

	/** R4's identity row plus the whole role set as Discord sent it (R5: replacement, never merge). */
	private toRegistryMembership(member: DiscordMemberRecord): RegistryMembership {
		this.requireSameGuild("readMemberRoster", member.guildId);
		return { guildId: this.guildId, userId: member.userId, roleIds: member.roleIds };
	}

	/**
	 * R1 inside a record: a guild-scoped read cannot legitimately carry another Guild's rows, so one that does
	 * is refused rather than stored under the configured id — which would be a forged grant — or dropped as if
	 * the registry were simply empty.
	 */
	private requireSameGuild(operation: string, resultGuildId: DiscordIdentifier): void {
		if (resultGuildId === this.guildId) {
			return;
		}
		this.logger.error("guild-state bootstrap refused a record from another guild", {
			guildId: this.guildId,
			operation,
			resultGuildId
		});
		throw new GuildBootstrapGuildMismatchError(this.guildId, resultGuildId);
	}
}

function restReasonOf(failure: unknown): GuildBootstrapFailureReason | DiscordRestFailureReason | "unknown" {
	return failure instanceof DiscordRestFailureError ? failure.reason : "unknown";
}

function describeFailure(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}

/** The boundary's failure is an `Error` already; anything else is wrapped without inventing a message. */
function toError(failure: unknown): Error {
	return failure instanceof Error ? failure : new Error(describeFailure(failure));
}
