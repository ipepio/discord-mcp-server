import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * ADR 0009 / docs/features/session-refresh.md. Additive and append-only: the session model keeps its
 * own expiry semantics, and a refresh family is anchored to the sessions it issued.
 */
export const up = (pgm: MigrationBuilder): void => {
	pgm.sql(`
		CREATE TABLE oauth_refresh_token (
			token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
			client_id text NOT NULL REFERENCES oauth_client(client_id),
			session_id text NOT NULL REFERENCES hub_session(session_id),
			family_id uuid NOT NULL,
			issued_at timestamptz NOT NULL,
			expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
			consumed_at timestamptz
		);
		CREATE INDEX oauth_refresh_family ON oauth_refresh_token(family_id);
		CREATE INDEX oauth_refresh_family_live ON oauth_refresh_token(family_id) WHERE consumed_at IS NULL;
		CREATE INDEX oauth_refresh_expiry ON oauth_refresh_token(expires_at, token_hash);
	`);
};

export const down = (pgm: MigrationBuilder): void => {
	pgm.sql("DROP TABLE oauth_refresh_token;");
};
