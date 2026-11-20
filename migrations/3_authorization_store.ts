import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/** Authorization owns these tables; there are deliberately no guild-state foreign keys. */
export const up = (pgm: MigrationBuilder): void => {
	pgm.sql(`
		CREATE TABLE oauth_client (
			client_id text PRIMARY KEY,
			redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 20),
			created_at timestamptz NOT NULL
		);
		CREATE TABLE oauth_pending_request (
			discord_state text PRIMARY KEY,
			client_id text NOT NULL REFERENCES oauth_client(client_id),
			redirect_uri text NOT NULL,
			client_state text NOT NULL CHECK (length(client_state) > 0),
			code_challenge text NOT NULL,
			expires_at timestamptz NOT NULL
		);
		CREATE TABLE oauth_authorization_code (
			code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
			client_id text NOT NULL REFERENCES oauth_client(client_id),
			redirect_uri text NOT NULL,
			code_challenge text NOT NULL,
			user_id bigint NOT NULL CHECK (user_id > 0),
			expires_at timestamptz NOT NULL
		);
		CREATE TABLE hub_session (
			session_id text PRIMARY KEY,
			token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
			user_id bigint NOT NULL CHECK (user_id > 0),
			client_id text NOT NULL REFERENCES oauth_client(client_id),
			issued_at timestamptz NOT NULL,
			expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
			revoked_at timestamptz
		);
		CREATE INDEX hub_session_user_active ON hub_session(user_id) WHERE revoked_at IS NULL;
		CREATE INDEX hub_session_expiry ON hub_session(expires_at, session_id);
		CREATE INDEX oauth_pending_expiry ON oauth_pending_request(expires_at, discord_state);
		CREATE INDEX oauth_code_expiry ON oauth_authorization_code(expires_at, code_hash);
	`);
};

export const down = (pgm: MigrationBuilder): void => {
	pgm.sql(
		"DROP TABLE hub_session; DROP TABLE oauth_authorization_code; DROP TABLE oauth_pending_request; DROP TABLE oauth_client;"
	);
};
