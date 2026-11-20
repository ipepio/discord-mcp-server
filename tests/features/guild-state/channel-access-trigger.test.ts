import { describe, expect, it } from "vitest";
import type { ChannelUpdatedEvent } from "../../../src/features/discord/index.js";
import { DiscordEventKind as Kind } from "../../../src/features/discord/index.js";
import { InMemoryGuildResyncLedger } from "../../../src/features/guild-state/bootstrap/in-memory-resync-ledger.js";
import { UpsertChannelCommand } from "../../../src/features/guild-state/commands/upsert-channel.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { ChannelsIngestibilityGainedPort } from "../../../src/features/guild-state/gateways/channels-ingestibility-gained.port.js";
import { GuildStateEventSubscription } from "../../../src/features/guild-state/gateways/guild-state-event-subscription.gateway.js";
import type {
	GuildStateEventCommand,
	GuildStateEventDisposition
} from "../../../src/features/guild-state/gateways/guild-state-event-subscription.gateway.js";
import { detectChannelAccessTransition } from "../../../src/features/guild-state/models/domain/channel-access-rules.js";
import type { RegistryPermissionSnapshot } from "../../../src/features/guild-state/models/domain/registry-records.js";
import {
	FakePermissionSnapshotRepository,
	channelRow,
	membershipRow,
	overwriteRow,
	snapshotFixture
} from "./fakes/permission-snapshot-fixture.js";
import { FakeDiscordEventConsumer } from "./fakes/fake-discord-event-consumer.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * The channel-access trigger (`odd/tasks/ingestion-channel-access-trigger.md` S1, S2, S3, S6; T1).
 *
 * Two properties are proven here, and neither needs a database:
 *
 * 1. **The rule.** {@link detectChannelAccessTransition} is the one place "the bot just gained view" is
 *    decided: not-viewable → viewable, on a channel type that can carry text. Losing view and staying put are
 *    not triggers, and a category or a voice channel can never trigger because nothing is posted in it.
 * 2. **The seam.** `UpsertChannelCommand` evaluates the bot's own effective viewability *before* it replaces
 *    the overwrite set and *after* it, through the registry's committed five-stage derivation
 *    (`effective-permission-rules.ts`) — never a second derivation of its own — and calls the outbound port
 *    when, and only when, the transition is the trigger. The event-subscription binding then reports the
 *    fact on its disposition, because a caller that hands an event over must see the same answer the
 *    subscription would have produced.
 *
 * What this file cannot prove is that the row really is the one stored: that is the same command's write
 * path, proven against PostgreSQL in `tests/integration/guild-state-channel-events.integration.test.ts`, and
 * the end-to-end grant → history-rows chain is
 * `tests/integration/ingestion-channel-access-trigger.integration.test.ts`.
 */

const GUILD_ID = "160000000000000001";
const BOT_USER = "160000000000000100";
const CHANNEL = "160000000000000201";
const CATEGORY = "160000000000000204";
const VIEW_CHANNEL = "1024";

/* ------------------------------------------------------------------ the rule (S1, S2) */

describe("the channel-access transition rule (S1, S2)", () => {
	it("triggers on not-viewable → viewable on a channel that can carry text", () => {
		expect(detectChannelAccessTransition({ channelType: "guild-text", before: false, after: true })).toEqual({
			channelType: "guild-text",
			before: false,
			after: true,
			transition: "gained",
			ingestibilityGained: true
		});
		expect(
			detectChannelAccessTransition({ channelType: "public-thread", before: false, after: true })
				.ingestibilityGained
		).toBe(true);
	});

	it("never triggers on a channel type nothing is posted in", () => {
		// A category and a voice channel are not ingestible whatever the overwrite change did: there is no
		// history to walk and no message will ever arrive for them (guild-state's text-capability rule).
		expect(
			detectChannelAccessTransition({ channelType: "guild-category", before: false, after: true })
		).toMatchObject({ transition: "gained", ingestibilityGained: false });
		expect(detectChannelAccessTransition({ channelType: "guild-voice", before: false, after: true })).toMatchObject(
			{ transition: "gained", ingestibilityGained: false }
		);
	});

	it("does not trigger when the bot loses view, or when nothing about viewability changed", () => {
		expect(detectChannelAccessTransition({ channelType: "guild-text", before: true, after: false })).toMatchObject({
			transition: "lost",
			ingestibilityGained: false
		});
		expect(detectChannelAccessTransition({ channelType: "guild-text", before: true, after: true })).toMatchObject({
			transition: "unchanged",
			ingestibilityGained: false
		});
		expect(detectChannelAccessTransition({ channelType: "guild-text", before: false, after: false })).toMatchObject(
			{
				transition: "unchanged",
				ingestibilityGained: false
			}
		);
	});
});

/* ------------------------------------------------- the command's before/after seam (S1, S3) */

/** The bot cannot see the channel: no base grant and no overwrite that would give one. */
function withoutView(guildId: string = GUILD_ID): RegistryPermissionSnapshot {
	return snapshotFixture({
		guildId,
		userId: BOT_USER,
		membership: membershipRow(guildId, BOT_USER, []),
		channels: [channelRow(guildId, CHANNEL, "guild-text")],
		overwrites: []
	});
}

/** The bot can see it: a member-targeted overwrite allows `view-channel` (derivation stage 5). */
function withView(guildId: string = GUILD_ID): RegistryPermissionSnapshot {
	return snapshotFixture({
		guildId,
		userId: BOT_USER,
		membership: membershipRow(guildId, BOT_USER, []),
		channels: [channelRow(guildId, CHANNEL, "guild-text")],
		overwrites: [[CHANNEL, [overwriteRow(BOT_USER, "member", VIEW_CHANNEL)]]]
	});
}

interface CommandHarness {
	readonly command: UpsertChannelCommand;
	readonly registries: RecordingRegistries;
	readonly snapshot: FakePermissionSnapshotRepository;
	/** The channel ids the outbound port was told about, in call order. */
	readonly gained: string[];
}

/**
 * One command over one registry, with the snapshot reads it is expected to make handed in as the exact
 * sequence it will see: a command that evaluates before and after a write must not be given the same answer
 * twice, or the before/after seam would be untested.
 */
function commandHarness(readings: readonly RegistryPermissionSnapshot[]): CommandHarness {
	const config = createGuildStateConfig({ guildId: GUILD_ID });
	const logger = new RecordingLogger();
	const registries = new RecordingRegistries();
	// The registry already holds the row: the update path (not the create path) is what is being decided.
	registries.channels.set(CHANNEL, channelRow(GUILD_ID, CHANNEL, "guild-text"));

	const snapshot = new FakePermissionSnapshotRepository({ snapshot: readings.at(-1) ?? withoutView() });
	snapshot.queueSnapshots(readings);

	const gained: string[] = [];
	const port = new ChannelsIngestibilityGainedPort();
	port.bind((channelId) => gained.push(channelId));

	return {
		command: new UpsertChannelCommand({
			config,
			channelRegistry: registries.channelsContract,
			logger,
			accessTrigger: { botUserId: BOT_USER, snapshot, channelsIngestibilityGained: port }
		}),
		registries,
		snapshot,
		gained
	};
}

const grantEvent = {
	guildId: GUILD_ID,
	channelId: CHANNEL,
	channelType: "guild-text" as const,
	permissionOverwrites: [
		{ targetId: BOT_USER, targetType: "member" as const, allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
	]
};

describe("UpsertChannelCommand's access trigger (S1, S2, S3)", () => {
	it("reports a gained viewability and calls the outbound port exactly once", async () => {
		const harness = commandHarness([withoutView(), withView()]);

		const outcome = await harness.command.execute(grantEvent);

		expect(outcome).toMatchObject({
			status: "applied",
			channelId: CHANNEL,
			ingestibilityGained: true,
			accessTransition: { before: false, after: true, transition: "gained", ingestibilityGained: true }
		});
		expect(harness.gained).toEqual([CHANNEL]);
		// Two bounded reads, one per side of the overwrite replacement: the before-state is gone once it lands.
		expect(harness.snapshot.requests.map((request) => request.channelId)).toEqual([CHANNEL, CHANNEL]);
	});

	it("does not call the port for an update that leaves viewability where it was (rename only, S2)", async () => {
		const harness = commandHarness([withoutView(), withoutView()]);

		const outcome = await harness.command.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL,
			channelType: "guild-text",
			name: "renamed-channel",
			position: 4,
			// Discord reports the same (empty) overwrite set on a rename: the transition, not the event, decides.
			permissionOverwrites: []
		});

		expect(outcome).toMatchObject({
			status: "applied",
			ingestibilityGained: false,
			accessTransition: { transition: "unchanged", before: false, after: false }
		});
		expect(harness.gained).toEqual([]);
	});

	it("does not call the port when the bot loses view (S2)", async () => {
		const harness = commandHarness([withView(), withoutView()]);

		const outcome = await harness.command.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL,
			channelType: "guild-text",
			permissionOverwrites: [
				{ targetId: BOT_USER, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }
			]
		});

		expect(outcome).toMatchObject({
			status: "applied",
			ingestibilityGained: false,
			accessTransition: { transition: "lost", before: true, after: false }
		});
		expect(harness.gained).toEqual([]);
	});

	it("evaluates a create from 'no stored row' instead of reading a before-state that cannot exist (S1)", async () => {
		// A create reads once: the before-state is `channel-not-registered`, so only the after-state is read.
		const harness = commandHarness([withView()]);
		// A channel the registry has never held.
		harness.registries.channels.clear();

		const outcome = await harness.command.execute({ ...grantEvent });

		expect(outcome).toMatchObject({ status: "applied", created: true, ingestibilityGained: true });
		expect(harness.gained).toEqual([CHANNEL]);
		expect(harness.snapshot.requests).toHaveLength(1);
	});

	it("evaluates nothing at all when the payload carried no overwrite set (bounded reads, R10)", async () => {
		const harness = commandHarness([withoutView()]);

		const outcome = await harness.command.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL,
			channelType: "guild-text",
			name: "renamed-channel"
		});

		expect(outcome).toMatchObject({
			status: "applied",
			ingestibilityGained: false,
			accessTransition: null,
			pendingRestFields: ["permissionOverwrites"]
		});
		expect(harness.snapshot.requests).toEqual([]);
		expect(harness.gained).toEqual([]);
	});

	it("never evaluates a channel type nothing is posted in, even when the overwrite change granted view", async () => {
		const harness = commandHarness([
			snapshotFixture({
				guildId: GUILD_ID,
				userId: BOT_USER,
				membership: membershipRow(GUILD_ID, BOT_USER, []),
				channels: [channelRow(GUILD_ID, CATEGORY, "guild-category")]
			})
		]);
		harness.registries.channels.set(CATEGORY, channelRow(GUILD_ID, CATEGORY, "guild-category"));

		const outcome = await harness.command.execute({
			guildId: GUILD_ID,
			channelId: CATEGORY,
			channelType: "guild-category",
			permissionOverwrites: [
				{ targetId: BOT_USER, targetType: "member", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
			]
		});

		expect(outcome).toMatchObject({ status: "applied", ingestibilityGained: false, accessTransition: null });
		expect(harness.snapshot.requests).toEqual([]);
		expect(harness.gained).toEqual([]);
	});

	it("keeps the registry write when the bot's viewability cannot be evaluated (S3: the signal is derived)", async () => {
		const harness = commandHarness([withoutView(), withView()]);
		harness.snapshot.failNext(new Error("snapshot read failed"));

		const outcome = await harness.command.execute({ ...grantEvent });

		// The event is applied: the trigger is an auxiliary fact and never a precondition for the row.
		expect(outcome).toMatchObject({
			status: "applied",
			overwriteSetReplaced: true,
			ingestibilityGained: false,
			accessTransition: null
		});
		expect(harness.gained).toEqual([]);
	});
});

/* ------------------------------------------------------ the disposition the binding reports (S3) */

/** A command the binding may reach but this harness never gives it a reason to. */
function unboundCommand<Input, Output>(): GuildStateEventCommand<Input, Output> {
	return {
		execute: async () => {
			throw new Error("this harness binds no such command");
		}
	};
}

function channelUpdated(): ChannelUpdatedEvent {
	return {
		kind: Kind.channelUpdated,
		guildId: GUILD_ID,
		channelId: CHANNEL,
		channelType: "guild-text",
		name: "renamed-channel",
		permissionOverwrites: [
			{ targetId: BOT_USER, targetType: "member", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
		]
	};
}

async function dispositionOf(readings: readonly RegistryPermissionSnapshot[]): Promise<GuildStateEventDisposition> {
	const config = createGuildStateConfig({ guildId: GUILD_ID });
	const logger = new RecordingLogger();
	const registries = new RecordingRegistries();
	registries.channels.set(CHANNEL, channelRow(GUILD_ID, CHANNEL, "guild-text"));
	const snapshot = new FakePermissionSnapshotRepository({ snapshot: readings.at(-1) ?? withoutView() });
	snapshot.queueSnapshots(readings);
	const port = new ChannelsIngestibilityGainedPort();

	const binding = new GuildStateEventSubscription({
		config,
		logger,
		consumer: new FakeDiscordEventConsumer(),
		ledger: new InMemoryGuildResyncLedger({ guildId: GUILD_ID }),
		guildRegistry: registries.guildsContract,
		upsertRole: unboundCommand(),
		deleteRole: unboundCommand(),
		applyMemberUpdate: unboundCommand(),
		endMembership: unboundCommand(),
		upsertChannel: new UpsertChannelCommand({
			config,
			channelRegistry: registries.channelsContract,
			logger,
			accessTrigger: { botUserId: BOT_USER, snapshot, channelsIngestibilityGained: port }
		}),
		deleteChannel: unboundCommand(),
		applyThreadMembershipChange: unboundCommand(),
		resync: unboundCommand()
	});

	return binding.handle(channelUpdated());
}

describe("the event-subscription binding's disposition (S3)", () => {
	it("reports the access trigger on the channel event that caused it", async () => {
		expect(await dispositionOf([withoutView(), withView()])).toMatchObject({
			status: "applied",
			command: "upsert-channel",
			ingestibilityGained: true
		});
	});

	it("reports no trigger for the same event when the bot's viewability did not change", async () => {
		expect(await dispositionOf([withoutView(), withoutView()])).toMatchObject({
			status: "applied",
			command: "upsert-channel",
			ingestibilityGained: false
		});
	});
});
