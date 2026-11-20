import { vi } from "vitest";
import type { AuthorizationStoreRepository } from "../../../src/features/authorization/repositories/authorization-store.repository.js";

export function authorizationStoreFixture() {
	return {
		insertClient: vi.fn<AuthorizationStoreRepository["insertClient"]>().mockResolvedValue(undefined),
		findClient: vi.fn<AuthorizationStoreRepository["findClient"]>().mockResolvedValue(null),
		insertPendingRequest: vi
			.fn<AuthorizationStoreRepository["insertPendingRequest"]>()
			.mockResolvedValue(undefined),
		consumePendingRequest: vi.fn<AuthorizationStoreRepository["consumePendingRequest"]>().mockResolvedValue(null),
		insertCode: vi.fn<AuthorizationStoreRepository["insertCode"]>().mockResolvedValue(undefined),
		consumeCode: vi.fn<AuthorizationStoreRepository["consumeCode"]>().mockResolvedValue(null),
		insertSession: vi.fn<AuthorizationStoreRepository["insertSession"]>().mockResolvedValue(undefined),
		findActiveSession: vi.fn<AuthorizationStoreRepository["findActiveSession"]>().mockResolvedValue(null),
		findSessionByTokenHash: vi.fn<AuthorizationStoreRepository["findSessionByTokenHash"]>().mockResolvedValue(null),
		revokeSession: vi.fn<AuthorizationStoreRepository["revokeSession"]>().mockResolvedValue(0),
		revokeUserSessions: vi.fn<AuthorizationStoreRepository["revokeUserSessions"]>().mockResolvedValue(0),
		insertRefreshToken: vi.fn<AuthorizationStoreRepository["insertRefreshToken"]>().mockResolvedValue(undefined),
		findRefreshToken: vi.fn<AuthorizationStoreRepository["findRefreshToken"]>().mockResolvedValue(null),
		consumeRefreshToken: vi.fn<AuthorizationStoreRepository["consumeRefreshToken"]>().mockResolvedValue(null),
		revokeRefreshFamily: vi.fn<AuthorizationStoreRepository["revokeRefreshFamily"]>().mockResolvedValue(0),
		revokeUserRefreshTokens: vi.fn<AuthorizationStoreRepository["revokeUserRefreshTokens"]>().mockResolvedValue(0),
		deleteExpiredRefreshTokens: vi
			.fn<AuthorizationStoreRepository["deleteExpiredRefreshTokens"]>()
			.mockResolvedValue(0),
		deleteDeadRefreshFamilyTokens: vi
			.fn<AuthorizationStoreRepository["deleteDeadRefreshFamilyTokens"]>()
			.mockResolvedValue(0),
		purgeExpired: vi.fn<AuthorizationStoreRepository["purgeExpired"]>().mockResolvedValue(0)
	};
}
