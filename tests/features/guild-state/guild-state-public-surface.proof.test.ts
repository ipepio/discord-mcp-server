import { describe, expect, it } from "vitest";
import * as guildStateSurface from "../../../src/features/guild-state/index.js";

/**
 * T9b — the public barrel stays as narrow as its own comment claims (docs/features/guild-state.md Contracts
 * and boundaries: "Other features never import this feature's repositories, SQL or tables";
 * docs/architecture/structure.md: the intentional `index.ts` is the only cross-feature door).
 *
 * The list below is asserted exactly, not as a subset, because the failure mode this guards against is
 * addition: a repository, a write command or a transport type exported one line at a time reads like
 * convenience and ends as a second write path around the rules that make a row mean something (R13). A name
 * that appears here by accident is a defect in the surface, so an unexpected export fails this case and a
 * removed one fails it too — the barrel is a contract, not a sketch.
 */
const EXPECTED_VALUE_EXPORTS = [
	/* Composition */
	"GuildStateModule",
	"GUILD_STATE_CONFIG_TOKEN",
	"GUILD_STATE_EVENT_SUBSCRIPTION_TOKEN",
	"GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN",
	"GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN",
	"GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN",
	"GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN",
	"GUILD_STATE_LOGGER_TOKEN",
	"GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN",
	"GUILD_STATE_STATUS_QUERY_TOKEN",
	"GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN",
	/* The event-subscription binding and its table */
	"GuildStateEventSubscription",
	"GUILD_STATE_BOUND_COMMANDS",
	"GUILD_STATE_BOUND_EVENT_KINDS",
	/* The outbound access-trigger port: the composition's half of one permission decision (S1, S3) */
	"ChannelsIngestibilityGainedPort",
	/* The six public use cases */
	"EvaluateEffectivePermissionsQuery",
	"GetGuildIdentityQuery",
	"GetGuildStateStatusQuery",
	"GetMembershipStatusQuery",
	"ListIngestibleChannelsQuery",
	"ListUserAccessibleChannelsQuery",
	/* The vocabulary those signatures are written in */
	"DISCORD_PERMISSION_NAMES",
	"GUILD_BOOTSTRAP_PARTS",
	"GUILD_REGISTRY_STATUSES",
	"GUILD_STATE_ANOMALY_REASONS",
	"REGISTRY_GAP_KINDS",
	"registryGapKey",
	/* The errors a caller must tell apart from a deny */
	"EffectivePermissionEvaluationError",
	"GuildBootstrapUnavailableError",
	"InvalidDiscordIdentifierError",
	"InvalidRegistryFieldValueError"
].sort();

/** Names that must never be reachable from this file, whichever way they are spelled. */
const FORBIDDEN_NAME_PATTERNS = [
	/Repository/i,
	/Postgres/i,
	/Sql/i,
	/Pg/i,
	/Migration/i,
	/Gateway/i,
	/Dispatcher/i,
	/Consumer/i,
	/Adapter/i,
	/Controller/i,
	/Dto/i,
	/Command$/
] as const;

describe("guild-state public surface (T9b, Contracts)", () => {
	it("exports exactly the names the Contracts section names, and nothing else", () => {
		expect(Object.keys(guildStateSurface).sort()).toEqual(EXPECTED_VALUE_EXPORTS);
	});

	it("leaks no repository, SQL, transport or write-command surface (R13, Contracts)", () => {
		const offenders = Object.keys(guildStateSurface).filter((name) =>
			FORBIDDEN_NAME_PATTERNS.some((pattern) => pattern.test(name))
		);
		expect(offenders).toEqual([]);
	});

	it("exports the seven write commands and the bootstrap/resync machinery by no name at all (R13)", () => {
		// The registry changes only from the event stream and the REST path behind it, so a consumer cannot
		// write state, cannot spend the connection's REST budget, and cannot reach the gateway adapter.
		const writeSurface = [
			"UpsertRoleCommand",
			"DeleteRoleCommand",
			"ApplyMemberUpdateCommand",
			"EndMembershipCommand",
			"UpsertChannelCommand",
			"DeleteChannelCommand",
			"ApplyThreadMembershipChangeCommand",
			"ApplyGuildBootstrapCommand",
			"ResyncGuildStateCommand",
			"GuildStateGateway",
			"DiscordGuildStateGateway",
			"PermissionSnapshotRepository",
			"RegistryPermissionSnapshot"
		] as const;
		for (const name of writeSurface) {
			expect(guildStateSurface, name).not.toHaveProperty(name);
		}
	});

	it("re-exports no other feature's vocabulary under its own name (one barrel, one meaning)", () => {
		// `channelType` on a list entry is the `discord` feature's `NormalizedChannelType`, reachable from
		// that feature's own barrel. Re-exporting it here would let two barrels disagree about one name.
		for (const name of Object.keys(guildStateSurface)) {
			expect(name).not.toMatch(/^(DiscordEventKind|DISCORD_EVENT_KINDS|NormalizedDiscordEvent)/);
		}
	});

	it("keeps the anomaly and gap vocabularies closed, so a status report cannot grow a payload (R14)", () => {
		expect(guildStateSurface.GUILD_STATE_ANOMALY_REASONS.every((reason) => !/\s/.test(reason))).toBe(true);
		expect(guildStateSurface.REGISTRY_GAP_KINDS.every((kind) => !/\s/.test(kind))).toBe(true);
		expect(guildStateSurface.GUILD_REGISTRY_STATUSES).toEqual(["current", "incomplete", "stale", "unavailable"]);
		// The gap key is the R9 dedupe rule itself: kind and resource, never a value.
		expect(guildStateSurface.registryGapKey({ kind: "role-id-deferred", resourceId: "1", reason: "r" })).toBe(
			"role-id-deferred:1"
		);
	});

	it("binds exactly the kinds Contracts lists, and every bound kind is a real exported value", () => {
		// The table is a runtime array, not a type: a kind added to the `discord` vocabulary and silently
		// left out of this binding is a decision the barrel cannot make quietly.
		expect(guildStateSurface.GUILD_STATE_BOUND_EVENT_KINDS).toHaveLength(16);
		expect(new Set(guildStateSurface.GUILD_STATE_BOUND_EVENT_KINDS).size).toBe(16);
		expect([...guildStateSurface.GUILD_STATE_BOUND_COMMANDS]).toContain("resync-guild-state");
		// The binding is the feature's only way in from the stream, and it is a class, not an instance:
		// composing it is the module's job and subscribing it is the composition root's.
		expect(typeof guildStateSurface.GuildStateEventSubscription).toBe("function");
	});
});
