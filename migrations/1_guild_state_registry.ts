import type { MigrationBuilder } from "node-pg-migrate";

/**
 * T1 of `odd/tasks/guild-state.md`: the permission-registry schema (docs/features/guild-state.md R1 to R9,
 * docs/adr/0003-postgresql-without-orm.md, docs/architecture/persistence.md).
 *
 * Shape of the registry. Channel and thread live in ONE registry (`channel`), because permission evaluation
 * walks a channel's parent chain and a thread is just a channel with a parent (R6). Roles, memberships and
 * overwrites are separate tables because each has its own lifecycle and its own cascade (R3, R4, R6).
 *
 * Integrity rules the schema itself enforces, not just the code above it:
 *
 * - Discord ids are `bigint` columns and never strings of arbitrary length, so a malformed id fails at the
 *   column rather than silently widening (R9). The application side of the same rule — ids carried as JS
 *   strings — lives in `src/features/guild-state/models/domain/discord-identifier.ts`.
 * - Permission bitfields are `text` with a digits-only check: Discord sends them as decimal strings and the
 *   registry stores that exact encoding, because a 64-bit bitfield loses precision the moment it becomes a
 *   JavaScript number (R3).
 * - A thread row is never stored parentless: `is_thread` plus a CHECK (R6). `is_thread` is a stored
 *   projection of the normalized channel type so the integrity rule is expressible in SQL without naming
 *   Discord's type vocabulary in a constraint; the domain owns which types are threads.
 * - Every row carries its Guild id and every dependent table's foreign key is composite on it, so a role,
 *   membership, channel, overwrite or thread-membership row cannot be attached to a foreign Guild (R1).
 * - `guild_registry_single_guild_index` is a unique index on a constant: at most one Guild row can exist,
 *   which is R1's "exactly one Guild" statement made structural.
 * - No `ON DELETE CASCADE`: every removal is an explicit repository transaction so the cascade and its
 *   counts are observable (R3, R4, R6, R14). The foreign keys are `NO ACTION`, so a cascade the repository
 *   forgot becomes a loud constraint violation instead of orphan rows.
 *
 * The DDL is written as explicit SQL rather than the helper DSL: table-level CHECKs, composite foreign keys
 * and a functional unique index read better as the statements they become, and this repository's rule is
 * that SQL stays SQL (ADR-0003). Values are never interpolated anywhere — this file contains no parameters,
 * only structure.
 */

/** Discord's own encoding of a permission bitfield: a decimal string, no sign, no separators (R3). */
const DISCORD_BITFIELD_PATTERN = "^[0-9]+$";

export const shorthands = undefined;

export const up = (pgm: MigrationBuilder): void => {
	// The one Guild this Installation serves (R1). `guild_name` is what GetGuildIdentityQuery reads (R13).
	pgm.sql(`
		CREATE TABLE guild (
			guild_id bigint PRIMARY KEY,
			guild_name text NOT NULL,
			CONSTRAINT guild_name_is_never_blank CHECK (guild_name <> '')
		)
	`);
	pgm.sql("CREATE UNIQUE INDEX guild_registry_single_guild_index ON guild ((true))");

	// Roles, including @everyone, whose row id equals the Guild id (R3).
	pgm.sql(`
		CREATE TABLE guild_role (
			role_id bigint PRIMARY KEY,
			guild_id bigint NOT NULL REFERENCES guild (guild_id),
			role_name text NOT NULL,
			permissions_bitfield text NOT NULL,
			role_position integer NOT NULL,
			UNIQUE (guild_id, role_id),
			CONSTRAINT guild_role_bitfield_is_discord_text CHECK (permissions_bitfield ~ '${DISCORD_BITFIELD_PATTERN}')
		)
	`);

	// Membership identity: keyed by Guild plus user, and nothing else (R4).
	pgm.sql(`
		CREATE TABLE guild_membership (
			guild_id bigint NOT NULL REFERENCES guild (guild_id),
			user_id bigint NOT NULL,
			PRIMARY KEY (guild_id, user_id)
		)
	`);

	// The role set is its own rows, so one changed set is one replace and a member's roles are queryable (R4).
	pgm.sql(`
		CREATE TABLE guild_membership_role (
			guild_id bigint NOT NULL,
			user_id bigint NOT NULL,
			role_id bigint NOT NULL,
			PRIMARY KEY (guild_id, user_id, role_id),
			FOREIGN KEY (guild_id, user_id) REFERENCES guild_membership (guild_id, user_id),
			FOREIGN KEY (guild_id, role_id) REFERENCES guild_role (guild_id, role_id)
		)
	`);

	// One registry for channels and threads (R6). A thread's parent is resolvable or the row cannot exist.
	pgm.sql(`
		CREATE TABLE channel (
			channel_id bigint PRIMARY KEY,
			guild_id bigint NOT NULL REFERENCES guild (guild_id),
			channel_type text NOT NULL,
			channel_name text,
			channel_position integer,
			is_thread boolean NOT NULL,
			parent_channel_id bigint REFERENCES channel (channel_id),
			UNIQUE (guild_id, channel_id),
			CONSTRAINT channel_thread_has_parent CHECK (NOT is_thread OR parent_channel_id IS NOT NULL),
			CONSTRAINT channel_parent_is_not_itself CHECK (parent_channel_id IS NULL OR parent_channel_id <> channel_id)
		)
	`);
	pgm.sql("CREATE INDEX channel_guild_parent_index ON channel (guild_id, parent_channel_id)");

	// Per-channel overwrite sets, one row per target, with Discord's allow and deny bitfields as text (R6).
	pgm.sql(`
		CREATE TABLE channel_permission_overwrite (
			guild_id bigint NOT NULL,
			channel_id bigint NOT NULL,
			overwrite_target_id bigint NOT NULL,
			overwrite_target_type text NOT NULL,
			allow_bitfield text NOT NULL,
			deny_bitfield text NOT NULL,
			PRIMARY KEY (channel_id, overwrite_target_id),
			FOREIGN KEY (guild_id, channel_id) REFERENCES channel (guild_id, channel_id),
			CONSTRAINT channel_permission_overwrite_target_is_role_or_member
				CHECK (overwrite_target_type IN ('role', 'member')),
			CONSTRAINT channel_permission_overwrite_allow_is_discord_text
				CHECK (allow_bitfield ~ '${DISCORD_BITFIELD_PATTERN}'),
			CONSTRAINT channel_permission_overwrite_deny_is_discord_text
				CHECK (deny_bitfield ~ '${DISCORD_BITFIELD_PATTERN}')
		)
	`);

	// Private-thread membership (R8): one row per thread per member, guild-bound through the thread row.
	// Deliberately no foreign key on `user_id` to `guild_membership`: the thread-member reconciliation
	// delivers user ids only, and R8 requires the membership fact to stand on its own.
	pgm.sql(`
		CREATE TABLE thread_membership (
			guild_id bigint NOT NULL,
			thread_id bigint NOT NULL,
			user_id bigint NOT NULL,
			PRIMARY KEY (thread_id, user_id),
			FOREIGN KEY (guild_id, thread_id) REFERENCES channel (guild_id, channel_id)
		)
	`);
	pgm.sql("CREATE INDEX thread_membership_guild_user_index ON thread_membership (guild_id, user_id)");
};

export const down = (pgm: MigrationBuilder): void => {
	// Reverse dependency order, and nothing that was not created here.
	pgm.sql("DROP TABLE IF EXISTS thread_membership");
	pgm.sql("DROP TABLE IF EXISTS channel_permission_overwrite");
	pgm.sql("DROP TABLE IF EXISTS channel");
	pgm.sql("DROP TABLE IF EXISTS guild_membership_role");
	pgm.sql("DROP TABLE IF EXISTS guild_membership");
	pgm.sql("DROP TABLE IF EXISTS guild_role");
	pgm.sql("DROP TABLE IF EXISTS guild");
};
