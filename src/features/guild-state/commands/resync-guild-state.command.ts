import type { DiscordEventKind } from "../../discord/index.js";
import { DiscordRestFailureError } from "../../discord/index.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { GuildStateGateway } from "../gateways/guild-state-gateway.interface.js";
import { GuildBootstrapUnavailableError } from "../models/domain/bootstrap.errors.js";
import type {
	GuildBootstrapGap,
	GuildBootstrapReport,
	GuildBootstrapStateTracker
} from "../models/domain/bootstrap-state.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	GuildRegistryStatus,
	GuildResyncStateLedger,
	GuildStateAnomalyReason,
	RegistryGapKind,
	RegistryGapRecord
} from "../models/domain/resync-state.js";
import { completeAnomalyCounts, deriveGuildRegistryStatus, gapCountsByKind } from "../models/domain/resync-state.js";
import type { VanishedStateSweepReport } from "../models/domain/vanished-state.js";
import type { ChannelRegistryRepository } from "../repositories/channel-registry.repository.js";
import type { RoleRegistryRepository } from "../repositories/role-registry.repository.js";
import type { ApplyGuildBootstrapCommand } from "./apply-guild-bootstrap.command.js";
import type { SweepVanishedStateCommand } from "./sweep-vanished-state.command.js";
import type { UpsertRoleCommand } from "./upsert-role.command.js";

/**
 * The post-reconnect / post-anomaly convergence (docs/features/guild-state.md R11, with R2, R9, R10).
 *
 * What R11 requires, and how this command meets it:
 *
 * - **Reuse the bootstrap path, never duplicate it.** The tracker is reset — which is R2's "the same bootstrap
 *   path" for a registry flagged stale — and the re-convergence itself is delegated to
 *   {@link ApplyGuildBootstrapCommand}, so pagination, the bounded batch transactions, the absent-is-not-empty
 *   rule, the Guild-mismatch refusal and the loud `unavailable` on a lost Guild exist in exactly one place.
 *   A snapshot never partially overwrites (R10) because the pass it delegates to is the whole-snapshot pass.
 * - **Full replace-and-converge, not a replay of missed events** (R11 boundary). The signal's `affectedKinds`
 *   are recorded as facts for the anomaly report and the log, and they narrow nothing: the reset makes every
 *   part pending and every write is a wholesale replacement keyed on Discord's ids, so an unaffected resource
 *   is re-confirmed and an affected one is corrected (R9, R10). Guessing which parts a kind touches would be
 *   a second, weaker copy of R2.
 * - **Targeted completion of what the event path could not know.** Three gap kinds carry over from earlier
 *   tasks, and each is closed by the one read that can legitimately answer it, asked at most once per resync:
 *   a role a `UpsertRoleCommand` refused for omitted fields (R3's error case) is completed from the fresh role
 *   list and re-applied through that same command; a channel left with `pendingRestFields:
 *   ["permissionOverwrites"]` (T5, R10's absent-is-not-empty boundary) is completed from the fresh channel
 *   list through `replaceChannelOverwrites`; and a member role id deferred at the foreign key (R5's error case,
 *   recorded as L3) converges because the fresh role list and the fresh roster have already run — the gap is
 *   closed only once the role row is actually there.
 * - **What stays open, stays open.** An unknown-thread deferral (R8's error case, open decision O1) is never
 *   closed here: the thread membership that would close it is exactly the data Discord may not deliver, and
 *   inventing it would be the security gap O1 warns about. Such a gap is recorded in the result and keeps the
 *   status `stale`.
 * - **Convergence sweeps what the outage removed** (R11's security content). The bootstrap pass writes the state
 *   Discord reported; it does not remove the state Discord stopped reporting, so a member who left, a role that
 *   was deleted or a channel that was deleted during the outage would otherwise keep handing out grants. After a
 *   successful pass this command runs {@link SweepVanishedStateCommand} against the sets the pass read — memberships,
 *   roles and channels the registry still holds and the read no longer names — through the same cascades the event
 *   path uses (R3, R4, R6). It is called on this path only, never by a first bootstrap, and it refuses to sweep
 *   memberships from a roster that stopped at its page bound (R2), because a page bound is not a departure list.
 * - **Bounded and idempotent.** One bootstrap pass, at most one role read and one channel read, and an epoch
 *   gate: a signal no newer than the last converged one is answered without touching the registry (R9, R11).
 * - **A lost Guild is loud.** A 4xx on the Guild read arrives as {@link GuildBootstrapUnavailableError}; the
 *   ledger is marked `unavailable`, the reason is counted, and the result says `unavailable` rather than
 *   pretending a partial read is current. The retry is the caller's, and it keeps retrying precisely because
 *   the status stays `unavailable` (R1 boundary, R2 error case, R11 error case).
 *
 * No transaction spans a Discord REST call, and no Gateway subscription is bound here: T9 wires the signal
 * onto this `execute(input)`.
 */

/** One gap the caller declares for this resync, in the vocabulary the reporting commands already use. */
export type ResyncGapDeclaration = RegistryGapRecord;

/**
 * The facts of one `resync-needed` signal (docs/features/discord.md R5) plus the anomaly reports the event
 * path left behind. Nothing here is a transport type: the binding that reads a normalized signal maps it
 * field for field.
 */
export interface ResyncGuildStateInput {
	/** The signal's connection epoch, monotone per process; the gate that makes a replayed signal inert (R9). */
	readonly epoch: number;
	/** Why a gap was declared: `reconnect`, `dropped-delivery`, an anomaly name, or the caller's own label. */
	readonly reason?: string;
	/** The Guild the signal names. Anything other than the configured one is dropped and counted (R1). */
	readonly guildId?: DiscordIdentifier;
	/** Absent for a whole-connection gap; recorded, never used to narrow the pass (see the note above). */
	readonly affectedKinds?: readonly DiscordEventKind[];
	/** The refusals and deferrals the event commands reported (R3, R5, R7, R8) that a REST read can complete. */
	readonly gaps?: readonly ResyncGapDeclaration[];
	/** Serve an epoch already converged again. For a deliberate operator-triggered full re-read only. */
	readonly force?: boolean;
}

/** One targeted completion this resync attempted, with the read that answered it (R14: ids and counts). */
export interface ResyncTargetedCompletion {
	readonly kind: RegistryGapRecord["kind"];
	readonly resourceId: DiscordIdentifier;
	readonly outcome: "completed" | "still-open";
	/** Why it is still open when it is: the read's own fact, never a payload. */
	readonly reason?: string;
}

/** One resync run, reported. `status` is the ledger's and tracker's verdict, never this command's hope. */
export interface ResyncGuildStateResult {
	readonly guildId: DiscordIdentifier;
	readonly epoch: number;
	readonly status: GuildRegistryStatus;
	/** True when the signal was answered without a read because an equal or newer epoch already converged. */
	readonly skipped: boolean;
	/** The delegated bootstrap pass, or null when the run was skipped or stopped on a lost Guild. */
	readonly bootstrap: GuildBootstrapReport | null;
	/** Gaps this run closed, by kind and resource. */
	readonly resolvedGaps: readonly RegistryGapRecord[];
	/** Gaps still open afterwards, including every unknown-thread deferral (O1). */
	readonly openGaps: readonly RegistryGapRecord[];
	readonly gapCounts: Partial<Record<RegistryGapRecord["kind"], number>>;
	readonly anomalyCounts: Readonly<Record<GuildStateAnomalyReason, number>>;
	readonly targetedReads: { readonly roles: boolean; readonly channels: boolean };
	readonly completions: readonly ResyncTargetedCompletion[];
	/**
	 * What the convergence sweep removed from the registry, or null when no sweep ran: the run was skipped, the
	 * Guild was lost, the pass failed, or the sweep itself did ({@link SweepVanishedStateCommand}).
	 */
	readonly sweep: VanishedStateSweepReport | null;
	/** Present when the run stopped because the Guild could not be read (R2's error case, named). */
	readonly unavailable?: { readonly reason: GuildStateAnomalyReason; readonly detail: string };
}

/** One completion plus the ledger record it closed, kept internal to the run so the result stays transport-clean. */
type CompletionEntry = ResyncTargetedCompletion & { readonly gapRecord: RegistryGapRecord };

export interface ResyncGuildStateCommandDeps {
	readonly config: GuildStateConfig;
	readonly gateway: GuildStateGateway;
	readonly tracker: GuildBootstrapStateTracker;
	readonly ledger: GuildResyncStateLedger;
	/** The bootstrap path this command reuses (R11: "reuses the bootstrap path (R2)"). Never reimplemented. */
	readonly bootstrapCommand: ApplyGuildBootstrapCommand;
	/** The role application this command reuses for a completed role description (R3, R10). */
	readonly upsertRoleCommand: UpsertRoleCommand;
	/**
	 * The convergence sweep this command runs after the pass, and the only caller it has (R11): a first bootstrap
	 * never reaches it, so a registry that has only ever been written forward keeps the state Discord removed.
	 */
	readonly sweepCommand: SweepVanishedStateCommand;
	readonly roleRegistry: RoleRegistryRepository;
	readonly channelRegistry: ChannelRegistryRepository;
	readonly logger: AppLogger;
}

export class ResyncGuildStateCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly gateway: GuildStateGateway;

	private readonly tracker: GuildBootstrapStateTracker;

	private readonly ledger: GuildResyncStateLedger;

	private readonly bootstrapCommand: ApplyGuildBootstrapCommand;

	private readonly upsertRoleCommand: UpsertRoleCommand;

	private readonly sweepCommand: SweepVanishedStateCommand;

	private readonly roleRegistry: RoleRegistryRepository;

	private readonly channelRegistry: ChannelRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: ResyncGuildStateCommandDeps) {
		this.guildId = deps.config.guildId;
		this.gateway = deps.gateway;
		this.tracker = deps.tracker;
		this.ledger = deps.ledger;
		this.bootstrapCommand = deps.bootstrapCommand;
		this.upsertRoleCommand = deps.upsertRoleCommand;
		this.sweepCommand = deps.sweepCommand;
		this.roleRegistry = deps.roleRegistry;
		this.channelRegistry = deps.channelRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (input: ResyncGuildStateInput): Promise<ResyncGuildStateResult> => {
		// R1 at the signal boundary: a gap declared about another Guild is not this registry's to converge.
		if (input.guildId !== undefined && input.guildId !== this.guildId) {
			return this.dropForeignSignal(input, input.guildId);
		}

		const declared = this.recordDeclaredGaps(input.gaps ?? []);

		if (!this.requireForcedOrNewer(input)) {
			return this.result({
				epoch: input.epoch,
				skipped: true,
				bootstrap: null,
				resolved: [],
				targeted: { roles: false, channels: false },
				completions: [],
				sweep: null,
				unavailable: undefined
			});
		}

		// R2 + R11: forget what this process claimed applied, so the same bootstrap path reads everything again
		// and the idempotent writes re-confirm or correct it.
		this.tracker.reset();
		this.ledger.beginResync(input.epoch);
		this.logger.warn("guild-state resync started", {
			guildId: this.guildId,
			epoch: input.epoch,
			...(input.reason === undefined ? {} : { reason: input.reason }),
			// The kinds are the signal's own vocabulary; they are a report, never a narrowing (R11 boundary).
			...(input.affectedKinds === undefined ? {} : { affectedKinds: input.affectedKinds }),
			declaredGapCount: declared.length,
			pendingPartsBefore: this.tracker.pendingParts().length
		});

		let bootstrap: GuildBootstrapReport | null = null;
		let unavailable: ResyncGuildStateResult["unavailable"];
		try {
			bootstrap = await this.bootstrapCommand.execute();
			this.ledger.markAvailable();
		} catch (failure) {
			if (failure instanceof GuildBootstrapUnavailableError) {
				unavailable = { reason: "guild-unavailable", detail: failure.message };
				this.ledger.markUnavailable("guild-unavailable");
			} else {
				// A transient boundary failure: R11's error case — the status stays stale and the caller retries.
				this.ledger.countAnomaly("targeted-read-failed");
				this.recordGap({
					kind: "resync-read-failed",
					resourceId: this.guildId,
					reason: describeFailure(failure)
				});
				this.logger.error("guild-state resync stopped on a failed REST read; the registry stays stale", {
					guildId: this.guildId,
					epoch: input.epoch,
					reason: restReasonOf(failure),
					detail: describeFailure(failure)
				});
			}
		}

		this.recordBootstrapGaps(bootstrap);

		// R11's sweep, and the only place it is reached from. No pass, no sweep: with nothing read there is
		// nothing Discord has said is gone, and a sweep without a read would be a guess (R10).
		let sweep: VanishedStateSweepReport | null = null;
		if (unavailable === undefined && bootstrap !== null) {
			sweep = await this.sweepVanishedState(bootstrap, input.epoch);
		}

		const completions: CompletionEntry[] = [];
		const targeted = { roles: false, channels: false };
		if (unavailable === undefined) {
			const roleRun = await this.completeRoleGaps(declared);
			targeted.roles = roleRun.read;
			completions.push(...roleRun.completions);
			const channelRun = await this.completeOverwriteGaps(declared);
			targeted.channels = channelRun.read;
			completions.push(...channelRun.completions);
			await this.convergeDeferredRoleIds(declared, completions);
		}

		this.ledger.endResync(bootstrap === null ? undefined : input.epoch);
		this.logFinished(input, bootstrap, completions, sweep);

		return this.result({
			epoch: input.epoch,
			skipped: false,
			bootstrap,
			resolved: completions.filter((entry) => entry.outcome === "completed").map((entry) => entry.gapRecord),
			targeted,
			completions,
			sweep,
			unavailable
		});
	};

	/* ------------------------------------------------------------------- signal gate */

	/**
	 * R9 on the signal itself. Epochs rise within a process, so a signal no newer than the last converged one
	 * describes state this registry has already re-read; answering it with another full pass would be a
	 * duplicate delivery given write budget, not correctness.
	 */
	private requireForcedOrNewer(input: ResyncGuildStateInput): boolean {
		if (input.force === true) {
			return true;
		}
		const converged = this.ledger.snapshot().convergedEpoch;
		if (converged === null || input.epoch > converged) {
			return true;
		}

		this.logger.info("guild-state resync skipped; this epoch already converged", {
			guildId: this.guildId,
			epoch: input.epoch,
			convergedEpoch: converged,
			...(input.reason === undefined ? {} : { reason: input.reason })
		});
		return false;
	}

	/** R1: the foreign signal is named, counted and answered with the registry exactly as it was. */
	private dropForeignSignal(input: ResyncGuildStateInput, signalGuildId: DiscordIdentifier): ResyncGuildStateResult {
		this.ledger.countAnomaly("foreign-guild");
		this.logger.warn("guild-state dropped a resync signal for another guild", {
			guildId: this.guildId,
			eventGuildId: signalGuildId,
			epoch: input.epoch,
			operation: "resync-guild-state"
		});
		return this.result({
			epoch: input.epoch,
			skipped: true,
			bootstrap: null,
			resolved: [],
			targeted: { roles: false, channels: false },
			completions: [],
			sweep: null,
			unavailable: undefined
		});
	}

	/* ------------------------------------------------------------------ convergence sweep */

	/**
	 * R11's remove-half of convergence, asked of the sets the pass just read. The reads travel rather than being
	 * taken again: a second roster or role read inside one resync would spend the REST budget twice and could
	 * diff against a set that is not the one the registry was just written from.
	 *
	 * A sweep that fails is treated as a resync step that did not finish, which is R11's error case: the run
	 * reports, a gap is recorded so the status cannot read `current`, and the vanished rows stay for the next
	 * attempt rather than half-converging silently. It never softens into "converged": the counts below are what
	 * the registry actually lost, not what this run hoped for.
	 */
	private async sweepVanishedState(
		report: GuildBootstrapReport,
		epoch: number
	): Promise<VanishedStateSweepReport | null> {
		try {
			return await this.sweepCommand.execute({ guildId: this.guildId, reads: report.reads });
		} catch (failure) {
			this.ledger.countAnomaly("targeted-read-failed");
			this.recordGap({
				kind: "resync-read-failed",
				resourceId: this.guildId,
				reason: `sweep: ${describeFailure(failure)}`
			});
			this.logger.error(
				"guild-state resync sweep failed; vanished state stays in the registry and the status stays not-current",
				{
					guildId: this.guildId,
					epoch,
					operation: "sweep-vanished-state",
					detail: describeFailure(failure)
				}
			);
			return null;
		}
	}

	/* ----------------------------------------------------------------------- gap bookkeeping */

	/** The caller's reports enter the ledger before the pass, because the pass is what closes them. */
	private recordDeclaredGaps(gaps: readonly ResyncGapDeclaration[]): RegistryGapRecord[] {
		const recorded: RegistryGapRecord[] = [];
		for (const gap of gaps) {
			const resourceId = requireDiscordIdentifier(`resync gap ${gap.kind}`, gap.resourceId);
			const record: RegistryGapRecord = {
				kind: gap.kind,
				resourceId,
				reason: gap.reason,
				...(gap.pendingFields === undefined ? {} : { pendingFields: gap.pendingFields })
			};
			this.recordGap(record);
			this.countAnomalyFor(record);
			recorded.push(record);
		}
		return recorded;
	}

	private recordGap(gap: RegistryGapRecord): void {
		this.ledger.recordGap(gap);
	}

	/** Each gap kind is also an anomaly count, so one reason vocabulary serves both (R14: ids and counts). */
	private countAnomalyFor(gap: RegistryGapRecord): void {
		const reason = anomalyReasonFor(gap.kind);
		if (reason !== null) {
			this.ledger.countAnomaly(reason);
		}
	}

	/**
	 * The bootstrap's own gaps (R2's bounds, R8's coverage limit) become ledger gaps, so a resync that could not
	 * finish is visible in the status rather than being remembered only by whoever read the report.
	 */
	private recordBootstrapGaps(report: GuildBootstrapReport | null): void {
		if (report === null) {
			return;
		}
		for (const gap of report.gaps) {
			this.recordBootstrapGap(gap);
		}
	}

	private recordBootstrapGap(gap: GuildBootstrapGap): void {
		if (gap.part === "roster") {
			this.recordGap({ kind: "roster-truncated", resourceId: this.guildId, reason: gap.reason });
			this.ledger.countAnomaly("roster-truncated");
			return;
		}
		if (gap.part === "thread-members") {
			const threadIds = gap.threadIds ?? [];
			if (threadIds.length === 0) {
				this.recordGap({ kind: "thread-members-unreadable", resourceId: this.guildId, reason: gap.reason });
				this.ledger.countAnomaly("thread-member-list-unreadable");
				return;
			}
			for (const threadId of threadIds) {
				this.recordGap({ kind: "thread-members-unreadable", resourceId: threadId, reason: gap.reason });
				this.ledger.countAnomaly("thread-member-list-unreadable");
			}
			return;
		}
		// A part that failed outright is the same fact from here: the read did not finish, so the registry is stale.
		this.recordGap({ kind: "resync-read-failed", resourceId: this.guildId, reason: `${gap.part}: ${gap.reason}` });
		this.ledger.countAnomaly("targeted-read-failed");
	}

	/* ------------------------------------------------------------------ targeted completion */

	/**
	 * R3's error case, completed: a role whose event description was refused is read from the REST role list and
	 * re-applied through the same command that refused it, so the refusal path and the convergence path share
	 * one description rule and one write. At most one read per resync — the endpoint is the whole role list, so
	 * asking it per role id would multiply a bounded read by the number of gaps.
	 */
	private async completeRoleGaps(
		declared: readonly RegistryGapRecord[]
	): Promise<{ read: boolean; completions: CompletionEntry[] }> {
		const gaps = declared.filter((gap) => gap.kind === "role-incomplete-description");
		if (gaps.length === 0) {
			return { read: false, completions: [] };
		}

		let roles;
		try {
			roles = await this.gateway.readRoles();
		} catch (failure) {
			this.ledger.countAnomaly("targeted-read-failed");
			this.logger.error("guild-state resync role read failed; refused roles stay open", {
				guildId: this.guildId,
				operation: "readRoles",
				reason: restReasonOf(failure),
				detail: describeFailure(failure),
				gapCount: gaps.length
			});
			return { read: true, completions: gaps.map((gap) => this.stillOpen(gap, "targeted-read-failed")) };
		}

		const completions: CompletionEntry[] = [];
		for (const gap of gaps) {
			const record = roles.find((role) => role.roleId === gap.resourceId);
			if (record === undefined) {
				// Discord did not name this role either. Nothing to apply, so the gap stays exactly as open.
				completions.push(this.stillOpen(gap, "role-absent-from-rest-read"));
				continue;
			}
			const outcome = await this.upsertRoleCommand.execute({
				guildId: this.guildId,
				roleId: record.roleId,
				roleName: record.name,
				permissionsBitfield: record.permissionsBitfield,
				position: record.position
			});
			if (outcome.status === "applied") {
				completions.push(this.close(gap));
			} else {
				completions.push(this.stillOpen(gap, `role event refused: ${outcome.reason}`));
			}
		}
		return { read: true, completions };
	}

	/**
	 * R7 and R10's absent-is-not-empty boundary, completed: the fresh channel list is the targeted read, and an
	 * overwrite list that arrived — including an explicitly empty one — is applied as the whole set by the
	 * repository's own replacement transaction. A list that still did not arrive keeps the gap open: replacing
	 * the stored set with an empty one would be inventing a revocation.
	 */
	private async completeOverwriteGaps(
		declared: readonly RegistryGapRecord[]
	): Promise<{ read: boolean; completions: CompletionEntry[] }> {
		const gaps = declared.filter((gap) => gap.kind === "channel-pending-rest-fields");
		if (gaps.length === 0) {
			return { read: false, completions: [] };
		}

		let channels;
		try {
			channels = await this.gateway.readChannels();
		} catch (failure) {
			this.ledger.countAnomaly("targeted-read-failed");
			this.logger.error("guild-state resync channel read failed; pending overwrite sets stay open", {
				guildId: this.guildId,
				operation: "readChannels",
				reason: restReasonOf(failure),
				detail: describeFailure(failure),
				gapCount: gaps.length
			});
			return { read: true, completions: gaps.map((gap) => this.stillOpen(gap, "targeted-read-failed")) };
		}

		const completions: CompletionEntry[] = [];
		for (const gap of gaps) {
			const record = channels.find((channel) => channel.channelId === gap.resourceId);
			if (record === undefined) {
				completions.push(this.stillOpen(gap, "channel-absent-from-rest-read"));
				continue;
			}
			if (record.permissionOverwrites === undefined) {
				this.ledger.countAnomaly("payload-carried-no-overwrite-set");
				completions.push(this.stillOpen(gap, "rest-read-carried-no-overwrite-set"));
				continue;
			}
			// R10: a set that arrived is the whole set. The repository replaces, so nothing stale survives.
			await this.channelRegistry.replaceChannelOverwrites({
				guildId: this.guildId,
				channelId: record.channelId,
				overwrites: record.permissionOverwrites
			});
			completions.push(this.close(gap));
		}
		return { read: true, completions };
	}

	/**
	 * R5's error case as recorded in `odd/tasks/guild-state.md` L3: a member role set naming an id the foreign
	 * key could not resolve kept only the known roles. The fresh role list and the fresh roster above have
	 * already run, so this id either has a row now — in which case the roster pass carried it and the gap is
	 * closed — or does not, in which case it stays open. Nothing here writes a role-membership row by hand:
	 * that would be a merge, and R10 forbids one.
	 */
	private async convergeDeferredRoleIds(
		declared: readonly RegistryGapRecord[],
		completions: CompletionEntry[]
	): Promise<void> {
		const gaps = declared.filter((gap) => gap.kind === "role-id-deferred");
		if (gaps.length === 0) {
			return;
		}
		const known = new Set((await this.roleRegistry.findRoles(this.guildId)).map((role) => role.roleId));
		for (const gap of gaps) {
			completions.push(
				known.has(gap.resourceId) ? this.close(gap) : this.stillOpen(gap, "role-row-still-absent")
			);
		}
	}

	/**
	 * The gaps this command must never close. An unknown-thread deferral (R8's error case, O1) and the thread
	 * lists this Installation may not read are facts about what Discord delivers, not about what a resync can
	 * fetch: they stay open, they keep the status `stale`, and they are reported.
	 */
	private keepOpenObservationGaps(): void {
		const unobserved = this.ledger.gapsOf("thread-membership-unobserved").length;
		if (unobserved > 0) {
			this.logger.warn("guild-state resync left private-thread membership gaps open (O1 undecided)", {
				guildId: this.guildId,
				openThreadGapCount: unobserved
			});
		}
	}

	private close(gap: RegistryGapRecord): CompletionEntry {
		this.ledger.resolveGap(gap.kind, gap.resourceId);
		this.logger.info("guild-state resync completed a registry gap", {
			guildId: this.guildId,
			kind: gap.kind,
			resourceId: gap.resourceId
		});
		return { kind: gap.kind, resourceId: gap.resourceId, outcome: "completed", gapRecord: gap };
	}

	private stillOpen(gap: RegistryGapRecord, reason: string): CompletionEntry {
		// The gap stays recorded; only its description moves to what the read actually said (R14: names, values never).
		this.ledger.recordGap({ ...gap, reason });
		this.logger.warn("guild-state resync could not complete a registry gap; it stays open", {
			guildId: this.guildId,
			kind: gap.kind,
			resourceId: gap.resourceId,
			reason
		});
		return { kind: gap.kind, resourceId: gap.resourceId, outcome: "still-open", reason, gapRecord: gap };
	}

	/* ---------------------------------------------------------------------------- reporting */

	private logFinished(
		input: ResyncGuildStateInput,
		bootstrap: GuildBootstrapReport | null,
		completions: readonly CompletionEntry[],
		sweep: VanishedStateSweepReport | null
	): void {
		this.keepOpenObservationGaps();
		const snapshot = this.ledger.snapshot();
		this.logger.info("guild-state resync finished", {
			guildId: this.guildId,
			epoch: input.epoch,
			status: this.statusOf(),
			bootstrapComplete: bootstrap?.complete ?? false,
			completedGapCount: completions.filter((entry) => entry.outcome === "completed").length,
			openGapCount: snapshot.openGaps.length,
			// R14: the sweep's ids are logged by the sweep itself; the finish line carries its counts.
			...(sweep === null
				? {}
				: {
						sweptMemberships: sweep.removedMemberships,
						sweptRoles: sweep.removedRoles,
						sweptChannels: sweep.removedChannels,
						sweepSkippedTargets: sweep.skipped.map((skip) => skip.target)
					})
		});
	}

	private statusOf(): GuildRegistryStatus {
		const snapshot = this.ledger.snapshot();
		return deriveGuildRegistryStatus({
			unavailable: snapshot.unavailable,
			resyncInFlight: snapshot.resyncInFlight,
			pendingBootstrapParts: this.tracker.pendingParts(),
			openGaps: snapshot.openGaps
		});
	}

	private result(parts: {
		readonly epoch: number;
		readonly skipped: boolean;
		readonly bootstrap: GuildBootstrapReport | null;
		readonly resolved: readonly RegistryGapRecord[];
		readonly targeted: { readonly roles: boolean; readonly channels: boolean };
		readonly completions: readonly CompletionEntry[];
		readonly sweep: VanishedStateSweepReport | null;
		readonly unavailable: ResyncGuildStateResult["unavailable"];
	}): ResyncGuildStateResult {
		const snapshot = this.ledger.snapshot();
		const result: ResyncGuildStateResult = {
			guildId: this.guildId,
			epoch: parts.epoch,
			status: this.statusOf(),
			skipped: parts.skipped,
			bootstrap: parts.bootstrap,
			resolvedGaps: parts.resolved,
			openGaps: snapshot.openGaps,
			gapCounts: gapCountsByKind(snapshot.openGaps),
			anomalyCounts: completeAnomalyCounts(snapshot.anomalyCounts),
			targetedReads: parts.targeted,
			completions: parts.completions.map(({ gapRecord: _gapRecord, ...completion }) => completion),
			sweep: parts.sweep,
			...(parts.unavailable === undefined ? {} : { unavailable: parts.unavailable })
		};
		return result;
	}
}

function restReasonOf(failure: unknown): string {
	return failure instanceof DiscordRestFailureError ? failure.reason : "unknown";
}

function describeFailure(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The one mapping between a gap kind (what the registry holds open) and an anomaly reason (what the counter
 * reports). A deferred role id is not an anomaly at all — R5's error case says the id simply waits for its
 * role, so it counts nowhere — and the switch is exhaustive over {@link REGISTRY_GAP_KINDS} so a new kind has
 * to be judged here rather than silently dropped from the report.
 */
function anomalyReasonFor(kind: RegistryGapKind): GuildStateAnomalyReason | null {
	switch (kind) {
		case "role-incomplete-description":
			return "incomplete-role-description";
		case "channel-pending-rest-fields":
			return "payload-carried-no-overwrite-set";
		case "role-id-deferred":
			return null;
		case "roster-truncated":
			return "roster-truncated";
		case "thread-members-unreadable":
			return "thread-member-list-unreadable";
		case "thread-membership-unobserved":
			return "unknown-thread-membership";
		case "resync-read-failed":
			return "targeted-read-failed";
	}
}
