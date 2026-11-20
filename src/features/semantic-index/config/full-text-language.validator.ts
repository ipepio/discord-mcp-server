import type { EnvSource } from "../../../shared/config/app-config.interface.js";
import { InvalidConfigurationError } from "../../../shared/config/config.errors.js";

export type FullTextLanguage = "spanish" | "english" | "simple";

export function loadFullTextLanguage(env: EnvSource): FullTextLanguage {
	const language = env["FTS_LANGUAGE"]?.trim() || "spanish";
	if (language !== "spanish" && language !== "english" && language !== "simple") {
		throw new InvalidConfigurationError("FTS_LANGUAGE", "must be spanish, english or simple");
	}
	return language;
}
