import { randomUUID } from "node:crypto";
import { OAuthError } from "../models/domain/oauth-error.js";
import type { RegisteredClient } from "../models/domain/authorization-records.js";
import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";

export interface RegisterClientInput {
	readonly redirectUris: readonly string[];
	readonly grantTypes?: readonly string[];
	readonly responseTypes?: readonly string[];
	readonly tokenEndpointAuthMethod?: string;
}

function validRedirect(uri: string): boolean {
	try {
		const url = new URL(uri);
		return (
			uri.length <= 2048 &&
			!uri.includes("#") &&
			!url.href.includes("*") &&
			!url.username &&
			!url.password &&
			(url.protocol === "https:" ||
				(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
		);
	} catch {
		return false;
	}
}

/**
 * docs/features/authorization.md R19: the declared grants are a **set**. It must contain
 * `authorization_code`, it may contain `refresh_token`, and it may contain nothing else; order and
 * repetition carry no meaning. The set is validated and never stored — it records what the client says it
 * does and grants nothing, because the token endpoint decides every grant on its own terms.
 */
function validGrantTypes(declared: unknown): boolean {
	if (!Array.isArray(declared) || !declared.every((grant: unknown) => typeof grant === "string")) return false;
	const grants = new Set(declared as string[]);
	return (
		grants.has("authorization_code") &&
		[...grants].every((grant) => grant === "authorization_code" || grant === "refresh_token")
	);
}

export class RegisterClientCommand {
	public constructor(private readonly store: AuthorizationStoreRepository) {}
	public readonly execute = async (input: RegisterClientInput): Promise<RegisteredClient> => {
		if (
			input.redirectUris.length < 1 ||
			input.redirectUris.length > 20 ||
			!input.redirectUris.every(validRedirect) ||
			(input.tokenEndpointAuthMethod !== undefined && input.tokenEndpointAuthMethod !== "none") ||
			(input.grantTypes !== undefined && !validGrantTypes(input.grantTypes)) ||
			(input.responseTypes !== undefined &&
				(input.responseTypes.length !== 1 || input.responseTypes[0] !== "code"))
		) {
			throw new OAuthError("invalid_client_metadata", "Public authorization-code client metadata is required.");
		}
		const client: RegisteredClient = {
			clientId: randomUUID(),
			redirectUris: [...input.redirectUris],
			createdAt: new Date()
		};
		await this.store.insertClient(client);
		return client;
	};
}
