/**
 * The registry's own error vocabulary (docs/architecture/conventions.md: expected failures become named
 * errors). Nothing here carries a driver error, a SQL fragment or a Discord payload: a repository failure
 * names the operation and the ids involved, which is everything R14 asks a log line to prove.
 */

/** Base class for every guild-state registry failure. */
export abstract class GuildStateRegistryError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * A value that must land in a `bigint` column is not one (docs/features/guild-state.md R9). The registry
 * refuses it instead of discovering the rule inside a PostgreSQL cast error.
 */
export class InvalidDiscordIdentifierError extends GuildStateRegistryError {
	public constructor(
		public readonly field: string,
		public readonly reason: "not-a-string" | "not-decimal" | "out-of-bigint-range"
	) {
		super(`guild-state registry rejected ${field} as a Discord identifier (${reason})`);
	}
}

/**
 * A bitfield that is not Discord's own decimal string (docs/features/guild-state.md R3). Coercing it would
 * silently lose the high permissions, so the registry refuses the value instead.
 */
export class InvalidPermissionBitfieldError extends GuildStateRegistryError {
	public constructor(public readonly field: string) {
		super(`guild-state registry rejected ${field} as a Discord permission bitfield`);
	}
}

/**
 * A thread row without a resolvable parent, which R6 forbids: the registry rejects it rather than storing
 * a parentless thread that permission evaluation could never resolve.
 */
export class ThreadParentRequiredError extends GuildStateRegistryError {
	public constructor(
		public readonly guildId: string,
		public readonly channelId: string,
		public readonly channelType: string
	) {
		super(
			`guild-state registry rejected thread ${channelId} of type ${channelType} in guild ${guildId} without a parent channel`
		);
	}
}

/**
 * A second Guild row: the registry holds exactly one (R1), and the schema enforces it with
 * `guild_registry_single_guild_index`. This is the named translation of that one constraint and nothing
 * else (docs/architecture/persistence.md: translate a duplicate only when both the code and the intended
 * constraint match).
 */
export class SingleGuildViolationError extends GuildStateRegistryError {
	public constructor(public readonly rejectedGuildId: string) {
		super(`guild-state registry already holds another guild; ${rejectedGuildId} was refused (R1)`);
	}
}

/** A repository was handed a batch it will not write, e.g. an empty one where rows are required. */
export class InvalidRegistryBatchError extends GuildStateRegistryError {
	public constructor(
		public readonly operation: string,
		public readonly reason: string
	) {
		super(`guild-state registry batch for ${operation} was refused (${reason})`);
	}
}

/**
 * A value that must land in an `integer` column is not one (docs/features/guild-state.md R3: a role position is
 * stored as Discord reports it). The registry refuses the value instead of discovering the rule inside a
 * PostgreSQL cast, which would name a column and hide the field that produced it.
 */
export class InvalidRegistryFieldValueError extends GuildStateRegistryError {
	public constructor(
		public readonly field: string,
		public readonly reason: string
	) {
		super(`guild-state registry rejected ${field} (${reason})`);
	}
}

/**
 * An effective-permission evaluation that could not be carried out at all (docs/features/guild-state.md
 * R12; Contracts: "a technical evaluation error is a named technical error, never an empty set masquerading
 * as 'no permissions'"). The distinction is the whole point of the class: an empty set is an answer about
 * stored state, while this is a statement that the hub could not decide, and a caller must not be able to
 * render one as the other. It carries the ids involved and the cause, never a SQL fragment (R14).
 */
export class EffectivePermissionEvaluationError extends GuildStateRegistryError {
	public constructor(
		public readonly operation: "evaluate" | "scan",
		public readonly guildId: string,
		public readonly userId: string,
		public readonly channelId: string | null,
		/** The underlying failure, kept for the log's cause field and never stringified into the message. */
		public override readonly cause: unknown
	) {
		super(
			`guild-state effective-permission ${operation} failed for user ${userId} of guild ${guildId}${channelId === null ? "" : ` on channel ${channelId}`}`
		);
	}
}
