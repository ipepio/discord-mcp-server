import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sources(directory: string): readonly string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => readFileSync(resolve(entry.parentPath, entry.name), "utf8"));
}

describe("semantic index structural invariants", () => {
	it("R9: deployment explicitly discloses content egress and provider retention control", () => {
		const deployment = readFileSync(resolve("docs/deployment/semantic-index.md"), "utf8");
		expect(deployment).toContain("Message content is sent from this host to the configured embedding provider");
		expect(deployment).toContain("outside the\nhub's control");
	});
	it("R1: ingestion has no semantic-index/provider dependency", () => {
		for (const source of sources(resolve("src/features/ingestion"))) {
			expect(source).not.toMatch(/from\s+["'][^"']*(?:semantic-index|openai)[^"']*["']/);
		}
	});
	it("R5: provider has no logging path and pipeline logging never accepts exception objects or content", () => {
		const gateway = readFileSync(
			resolve("src/features/semantic-index/gateways/openai-embedding.gateway.ts"),
			"utf8"
		);
		expect(gateway).not.toMatch(/console\.|logger\./);
		for (const source of sources(resolve("src/features/semantic-index"))) {
			// Static diagnostic text may say "failure"; inspect variables, not string contents.
			const withoutStrings = source.replace(/"(?:\\.|[^"\\])*"/g, '""');
			expect(withoutStrings).not.toMatch(
				/logger\.(?:info|warn|error|debug)\([^;]*(?:\.content|apiKey|failure|exception)/
			);
		}
	});
	it("public contracts expose use cases, never tables, provider types or cross-channel artifacts", () => {
		const surface = readFileSync(resolve("src/features/semantic-index/index.ts"), "utf8");
		expect(surface).not.toMatch(/repository|gateway|provider|cluster|summary|tag/i);
	});
});
