import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

export const up = (pgm: MigrationBuilder): void => {
	// Stored state, not incoming event order, invalidates derived rows. No provider call or ingestion
	// adapter change: the background worker alone computes embeddings after this transaction commits.
	pgm.sql(`CREATE FUNCTION invalidate_message_embeddings() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			DELETE FROM message_embeddings WHERE message_id = NEW.message_id;
			RETURN NEW;
		END
	$$`);
	pgm.sql(`CREATE TRIGGER message_embeddings_lifecycle
		AFTER UPDATE OF content, deleted_at ON message
		FOR EACH ROW WHEN (OLD.content IS DISTINCT FROM NEW.content OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
		EXECUTE FUNCTION invalidate_message_embeddings()`);
};

export const down = (pgm: MigrationBuilder): void => {
	pgm.sql("DROP TRIGGER message_embeddings_lifecycle ON message");
	pgm.sql("DROP FUNCTION invalidate_message_embeddings()");
};
