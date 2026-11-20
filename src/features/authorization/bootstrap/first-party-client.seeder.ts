import { Inject } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { APP_LOGGER_TOKEN } from "../../../shared/logging/logging.tokens.js";
import { AUTHORIZATION_STORE_TOKEN } from "../authorization.tokens.js";
import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";

/**
 * The hub's own first-party client. A browser cannot perform dynamic client registration plus PKCE by
 * itself, so the landing signs in as this pre-registered public client and shows the resulting session.
 */
export const FIRST_PARTY_CLIENT_ID = "discord-mcp-server-web";

/** Ensures the first-party client row exists; idempotent, and safe when two instances start together. */
export class FirstPartyClientSeeder implements OnModuleInit {
	public constructor(
		@Inject(AUTHORIZATION_STORE_TOKEN)
		private readonly store: Pick<AuthorizationStoreRepository, "findClient" | "insertClient">,
		private readonly redirectUri: string,
		@Inject(APP_LOGGER_TOKEN) private readonly logger?: AppLogger
	) {}

	public async onModuleInit(): Promise<void> {
		const existing = await this.store.findClient(FIRST_PARTY_CLIENT_ID);
		if (existing) {
			if (!existing.redirectUris.includes(this.redirectUri)) {
				this.logger?.warn?.(
					`first-party client redirect differs from PUBLIC_BASE_URL (${FIRST_PARTY_CLIENT_ID})`
				);
			}
			return;
		}
		try {
			await this.store.insertClient({
				clientId: FIRST_PARTY_CLIENT_ID,
				redirectUris: [this.redirectUri],
				createdAt: new Date()
			});
		} catch (failure) {
			// A concurrent start may have inserted it first: that is success, not a startup failure.
			if (!(await this.store.findClient(FIRST_PARTY_CLIENT_ID))) throw failure;
		}
	}
}
