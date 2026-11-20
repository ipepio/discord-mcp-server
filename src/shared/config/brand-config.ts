import { readFileSync } from "node:fs";
import { InvalidConfigurationError } from "./config.errors.js";

/** Structural twin of the shared config's BrandEnv; importing it would cycle the contract file. */
type BrandEnv = Readonly<Record<string, string | undefined>>;

/**
 * Deployment-controlled identity for every user-visible string and mark. The functional core is
 * brand-agnostic; this is where an operator puts their own name, mark and interface language.
 */
export interface BrandConfig {
	/** The product name shown on the browser pages, MCP server metadata and diagnostics. */
	readonly name: string;
	/** Inline SVG the pages draw instead of the built-in mark, when the operator supplies one. */
	readonly markSvg: string | undefined;
	/** Browser surface language: `es` ships by default; `en` is available for English deployments. */
	readonly locale: "es" | "en";
	/** Lowercase identifier for PostgreSQL's `application_name` (diagnostics only). */
	readonly pgApplicationName: string;
}

const DEFAULT_NAME = "Discord MCP Server";
const NAME_LIMIT = 60;

function requireBrandName(env: BrandEnv): string {
	const name = env["HUB_BRAND_NAME"];
	if (name === undefined) return DEFAULT_NAME;
	const trimmed = name.trim();
	if (trimmed.length < 1) throw new InvalidConfigurationError("HUB_BRAND_NAME", "must not be empty");
	if (trimmed.length > NAME_LIMIT) {
		throw new InvalidConfigurationError("HUB_BRAND_NAME", `must be at most ${NAME_LIMIT} characters`);
	}
	return trimmed;
}

/** Lowercase ascii slug for diagnostics: every non-ascii or separator run becomes one dash. */
function pgApplicationNameOf(name: string): string {
	const slug = name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, NAME_LIMIT);
	return slug.length > 0 ? slug : "discord-mcp-server";
}

function requireLocale(env: BrandEnv): "es" | "en" {
	const raw = env["HUB_UI_LOCALE"];
	if (raw === undefined) return "es";
	const locale = raw.trim().toLowerCase();
	if (locale === "es" || locale === "en") return locale;
	throw new InvalidConfigurationError("HUB_UI_LOCALE", "must be `es` or `en`");
}

/**
 * Reads the operator's mark file once, at composition time. Anything other than a readable SVG is a
 * startup failure naming the variable — never a fallback that hides a wrong path.
 */
function readMarkSvg(env: BrandEnv, readFile: (path: string) => string): string | undefined {
	const path = env["HUB_BRAND_MARK_FILE"];
	if (path === undefined || path.trim() === "") return undefined;
	const trimmed = path.trim();
	let content: string;
	try {
		content = readFile(trimmed);
	} catch {
		throw new InvalidConfigurationError("HUB_BRAND_MARK_FILE", `cannot read ${trimmed}`);
	}
	if (!/<svg[\s>]/i.test(content)) {
		throw new InvalidConfigurationError("HUB_BRAND_MARK_FILE", "must contain an inline <svg> document");
	}
	return content.trim();
}

export function loadBrandConfig(
	env: BrandEnv,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
): BrandConfig {
	const name = requireBrandName(env);
	return Object.freeze({
		name,
		markSvg: readMarkSvg(env, readFile),
		locale: requireLocale(env),
		pgApplicationName: pgApplicationNameOf(name)
	});
}

/** The brand an instance actually draws: the configured one, or the product defaults. */
export function brandOrDefault(config: BrandConfig | undefined): BrandConfig {
	return config ?? loadBrandConfig({});
}
