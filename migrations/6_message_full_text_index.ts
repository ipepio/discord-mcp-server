import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;
export const up = (pgm: MigrationBuilder): void => {
	pgm.sql(
		"CREATE INDEX message_live_full_text ON message USING gin (to_tsvector('simple', content)) WHERE deleted_at IS NULL"
	);
};
export const down = (pgm: MigrationBuilder): void => {
	pgm.sql("DROP INDEX message_live_full_text");
};
