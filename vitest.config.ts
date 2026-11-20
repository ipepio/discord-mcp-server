/**
 * Test layout (docs/architecture/testing.md): unit/contract/fixture tests run with `npm test`, the
 * PostgreSQL-backed integration slice runs only with `npm run test:integration` because it needs an
 * explicitly supplied test database. Selection happens through Vite's mode, passed by the
 * `test:integration` script (`vitest run --mode integration`), so one configuration file drives both.
 */

import { defineConfig } from "vitest/config";

/** Generated negative fixtures are data for the architecture suite, never tests in their own right. */
const GENERATED_FIXTURES = "tests/architecture/.fixtures/**";

/** Files that need a real, explicitly configured PostgreSQL database (they must never be silent). */
const INTEGRATION_TESTS = "**/*.integration.test.ts";

export default defineConfig(({ mode }) => ({
	test: {
		include: mode === "integration" ? ["tests/**/*.integration.test.ts"] : ["tests/**/*.test.ts"],
		exclude:
			mode === "integration"
				? [GENERATED_FIXTURES, "node_modules/**", "dist/**"]
				: [GENERATED_FIXTURES, INTEGRATION_TESTS, "node_modules/**", "dist/**"],
		// Each integration suite provisions pgvector/HNSW in its own database on the shared test server.
		// Serialize suites to bound database/DDL pressure; isolation remains per-suite.
		fileParallelism: mode !== "integration",
		environment: "node",
		globals: false,
		restoreMocks: true,
		testTimeout: 30_000,
		hookTimeout: 30_000
	}
}));
