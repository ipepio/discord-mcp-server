import type { GetGuildIdentityQuery } from "../../guild-state/index.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { RegistryStatusReader } from "./query-access.policy.js";
import { composeConnectionInstructions } from "./server-instructions.js";
import type { InstructionsLocale } from "./server-instructions.js";

export class GetServerMetadataQuery {
	public constructor(
		private readonly status: RegistryStatusReader,
		private readonly identity: Pick<GetGuildIdentityQuery, "execute">,
		private readonly logger: AppLogger,
		private readonly brandName = "Discord MCP Server",
		/** O10: the configured interface locale, English when it is unset. */
		private readonly locale: InstructionsLocale = "en"
	) {}
	/** Called once for EACH connection, never cached. Identity failures do not block connection. */
	public async execute() {
		let guildName: string | undefined;
		let guildId: string | undefined;
		try {
			const state = await this.status.execute();
			guildId = state.guildId;
			if (state.status === "current" || state.status === "stale") {
				const identity = await this.identity.execute();
				if (identity.status === "registered" && identity.guild.guildId === guildId)
					guildName = identity.guild.guildName;
			}
		} catch {
			this.logger.error("query guild identity unavailable", guildId ? { guildId } : {});
		}
		const description = guildName
			? `Read-only Discord retrieval for Guild ${guildName}`
			: "Read-only Discord retrieval; Guild not yet identified";
		return {
			serverInfo: {
				name: guildName ? `${this.brandName} — ${guildName}` : `${this.brandName} — Guild not yet identified`,
				version: "1.0.0",
				description
			},
			// R15: onboarding text, not a restatement of the description; its identity half is read per
			// connection and a composition failure never blocks the connection (R8's error behavior reused).
			instructions: this.instructions(guildName, guildId),
			capabilities: { tools: { listChanged: false } }
		};
	}
	private instructions(guildName: string | undefined, guildId: string | undefined): string {
		try {
			return composeConnectionInstructions({
				brandName: this.brandName,
				locale: this.locale,
				guildName,
				guildId
			});
		} catch {
			this.logger.error("query connection instructions unavailable", guildId ? { guildId } : {});
			return composeConnectionInstructions({ brandName: this.brandName, locale: this.locale });
		}
	}
}
