import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/** Dimension is a schema contract, not an environment substitution. */
export const up = (pgm: MigrationBuilder): void => {
	pgm.sql("CREATE EXTENSION IF NOT EXISTS vector");
	pgm.sql(`
		CREATE TABLE message_embeddings (
			message_id bigint NOT NULL REFERENCES message(message_id),
			model text NOT NULL CHECK (btrim(model) <> ''),
			content_revision text NOT NULL,
			embedding vector(1536) NOT NULL,
			PRIMARY KEY (message_id, model)
		)
	`);
	pgm.sql("CREATE INDEX message_embeddings_hnsw ON message_embeddings USING hnsw (embedding vector_cosine_ops)");
};

export const down = (pgm: MigrationBuilder): void => {
	pgm.sql("DROP TABLE message_embeddings");
	// Extension may predate this feature and is deliberately retained.
};
