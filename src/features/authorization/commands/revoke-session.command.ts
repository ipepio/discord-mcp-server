import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";

export class RevokeSessionCommand {
	public constructor(private readonly store: AuthorizationStoreRepository) {}
	public readonly execute = (sessionId: string): Promise<number> => this.store.revokeSession(sessionId, new Date());
}
