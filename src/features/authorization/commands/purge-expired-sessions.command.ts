import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";

/** Housekeeping is explicit and bounded, never part of authentication correctness. */
export class PurgeExpiredSessionsCommand {
	public constructor(private readonly store: AuthorizationStoreRepository) {}
	public readonly execute = (limit: number): Promise<number> => this.store.purgeExpired(new Date(), limit);
}
