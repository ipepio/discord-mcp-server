/**
 * Formatting baseline from docs/architecture/conventions.md: tabs, tab width 4, double quotes,
 * print width 120, no trailing commas. This configuration is authoritative for the repository.
 */
const config = {
	useTabs: true,
	tabWidth: 4,
	printWidth: 120,
	semi: true,
	singleQuote: false,
	trailingComma: "none",
	endOfLine: "lf",
	overrides: [
		{
			files: "*.md",
			options: { proseWrap: "preserve", tabWidth: 4 }
		}
	]
};

export default config;
