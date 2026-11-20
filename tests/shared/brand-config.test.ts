/**
 * RED — brand configuration: deployment-controlled identity for every user-visible string and mark.
 * Written test-first against the contract the pages and metadata will consume.
 */
import { describe, expect, it } from "vitest";
import { loadBrandConfig } from "../../src/shared/config/brand-config.js";

const SERVICABLE_SVG = '<svg viewBox="0 0 10 10"><circle r="4"/></svg>';

describe("brand configuration", () => {
	it("defaults to the product identity when nothing is set", () => {
		const config = loadBrandConfig({});
		expect(config.name).toBe("Discord MCP Server");
		expect(config.locale).toBe("es");
		expect(config.markSvg).toBeUndefined();
		expect(config.pgApplicationName).toBe("discord-mcp-server");
	});

	it("accepts a custom name and derives an ascii postgres application name", () => {
		const config = loadBrandConfig({ HUB_BRAND_NAME: "Mi Hub Ñoño & Cía" });
		expect(config.name).toBe("Mi Hub Ñoño & Cía");
		expect(config.pgApplicationName).toBe("mi-hub-nono-cia");
		expect(config.pgApplicationName).toMatch(/^[a-z0-9-]{1,60}$/);
	});

	it("rejects an empty or oversized brand name with the variable name", () => {
		expect(() => loadBrandConfig({ HUB_BRAND_NAME: "" })).toThrow(/HUB_BRAND_NAME/);
		expect(() => loadBrandConfig({ HUB_BRAND_NAME: "   " })).toThrow(/HUB_BRAND_NAME/);
		expect(() => loadBrandConfig({ HUB_BRAND_NAME: "x".repeat(80) })).toThrow(/HUB_BRAND_NAME/);
	});

	it("reads the configured mark file once and only accepts svg content", () => {
		const readFile = (path: string) => (path === "/opt/brand/logo.svg" ? SERVICABLE_SVG : "");
		const config = loadBrandConfig({ HUB_BRAND_MARK_FILE: "/opt/brand/logo.svg" }, readFile);
		expect(config.markSvg).toBe(SERVICABLE_SVG);
	});

	it("fails startup naming the mark file when it is unreadable or not svg", () => {
		const readFile = (_path: string): string => {
			throw new Error("ENOENT");
		};
		expect(() => loadBrandConfig({ HUB_BRAND_MARK_FILE: "/missing.svg" }, readFile)).toThrow(/HUB_BRAND_MARK_FILE/);
		const notSvg = (path: string) => (path === "/opt/brand/logo.txt" ? "<html>nope</html>" : "");
		expect(() => loadBrandConfig({ HUB_BRAND_MARK_FILE: "/opt/brand/logo.txt" }, notSvg)).toThrow(
			/HUB_BRAND_MARK_FILE/
		);
	});

	it("validates the interface locale", () => {
		expect(loadBrandConfig({ HUB_UI_LOCALE: "en" }).locale).toBe("en");
		expect(() => loadBrandConfig({ HUB_UI_LOCALE: "fr" })).toThrow(/HUB_UI_LOCALE/);
	});
});
