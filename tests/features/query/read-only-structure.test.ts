import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sources(path: string): Promise<string[]> {
	const entries = await readdir(path, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map((entry) =>
				entry.isDirectory()
					? sources(join(path, entry.name))
					: Promise.resolve(entry.name.endsWith(".ts") ? [join(path, entry.name)] : [])
			)
		)
	).flat();
}
describe("query read-only structural boundary", () => {
	it("exposes no command, write repository, provider, Discord client or cross-feature internal import", async () => {
		const paths = await sources("src/features/query");
		for (const path of paths) {
			const text = await readFile(path, "utf8");
			expect(path).not.toMatch(/(?:commands|gateways)\//);
			if (path.includes("/controllers/")) expect(path).toBe("src/features/query/controllers/mcp.controller.ts");
			expect(text).not.toMatch(/\b(?:INSERT INTO|DELETE FROM|TRUNCATE TABLE|UPDATE\s+\w+\s+SET)\b/i);
			expect(text).not.toMatch(
				/from ["'][^"']*(?:discord\.js|embedding-provider|semantic-index\/(?!index\.js)|guild-state\/(?!index\.js))/
			);
			if (path.endsWith("index.ts")) expect(text).not.toMatch(/export[^;]*(?:Command|Postgres|Repository)/);
		}
	});
	it("message repositories require scope and contain unconditional tombstone predicates", async () => {
		const contract = await readFile("src/features/query/repositories/message-read.repository.ts", "utf8");
		expect(contract).toContain("readonly accessibleChannelIds: readonly string[]");
		const sql = await readFile("src/features/query/repositories/postgres-message-read.repository.ts", "utf8");
		expect(sql).toContain("m.deleted_at IS NULL");
		expect(sql).toContain("m.channel_id = ANY($2::bigint[])");
		expect(sql).not.toMatch(/SELECT\s+\*|\bOFFSET\b/i);
		expect(sql).not.toMatch(/attachment_bytes|download|fetch\(/);
	});
});
