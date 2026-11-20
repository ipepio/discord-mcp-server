import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { AppConfig } from "../../../shared/config/app-config.interface.js";
import { APP_CONFIG_TOKEN } from "../../../shared/config/config.tokens.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { APP_LOGGER_TOKEN } from "../../../shared/logging/logging.tokens.js";
import { GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN } from "../../guild-state/index.js";
import type { GetGuildIdentityQuery } from "../../guild-state/index.js";
import { brandOrDefault } from "../../../shared/config/brand-config.js";
import { AUTHORIZATION_PUBLIC_BASE_URL_TOKEN } from "./mcp-authentication.guard.js";
import { GOVERNOR_STYLE, brand, escapeHtml, initials, stringsFor } from "./page-kit.js";

/** The narrow response surface this controller needs; Express satisfies it. */
export interface LandingResponse {
	readonly setHeader: (name: string, value: string) => void;
	readonly status: (code: number) => LandingResponse;
	readonly type: (value: string) => LandingResponse;
	readonly send: (body: string) => void;
}

/** Public entry point: one decision per screen — sign in, or copy the endpoint for an agent. */
// An HTML page, not an API resource: it stays out of the OpenAPI document (ADR 0004/0006).
@ApiExcludeController()
@Controller()
export class LandingController {
	public constructor(
		@Inject(AUTHORIZATION_PUBLIC_BASE_URL_TOKEN) private readonly publicBaseUrl: string,
		@Inject(GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN)
		private readonly identity: Pick<GetGuildIdentityQuery, "execute">,
		@Inject(APP_CONFIG_TOKEN) private readonly config: AppConfig,
		@Inject(APP_LOGGER_TOKEN) private readonly logger?: AppLogger
	) {}

	@Get()
	public async landing(@Res() response: LandingResponse): Promise<void> {
		let guildName: string | undefined;
		try {
			const identity = await this.identity.execute();
			guildName = identity.status === "registered" ? identity.guild.guildName : undefined;
		} catch {
			// An unreadable registry must not break the page: the wording says it is not identified yet.
			this.logger?.warn?.("landing could not read the guild identity");
		}
		const brandConfig = brandOrDefault(this.config.brand);
		const s = stringsFor(brandConfig.locale);
		const guild = escapeHtml(guildName ?? s.notIdentified);
		const endpoint = escapeHtml(`${this.publicBaseUrl.replace(/\/+$/, "")}/mcp`);
		const minutes = Math.round((this.config.authorization?.sessionTtlSeconds ?? 3600) / 60);
		const session = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;

		response.setHeader("Cache-Control", "no-store");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'"
		);
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.type("text/html; charset=utf-8");
		response.status(200);
		response.send(`<!doctype html><html lang="${brandConfig.locale}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>${brandConfig.name} — ${guild}</title>
<style>${GOVERNOR_STYLE}</style></head><body><main class="auth-page"><section class="auth-card">
${brand(brandConfig.markSvg)}
<h1 class="auth-title">${brandConfig.name}</h1>
<p class="auth-sub">${s.landingSub}</p>
<span class="label">${s.landingField}</span>
<div class="server">
  <span class="server__avatar" aria-hidden="true">${initials(guildName)}</span>
  <span class="server__meta"><strong>${guild}</strong><small>${s.landingLimited}</small></span>
</div>
<a class="btn" href="/login">${s.landingCta}</a>
<ul class="chips">
  <li><b>${s.landingChipReadonly}</b><span>${s.landingChipReadonlyHint}</span></li>
  <li><b>${s.landingChipScope}</b><span>${s.landingChipScopeHint}</span></li>
  <li><b>${s.landingChipSession(session)}</b><span>${s.landingChipSessionHint}</span></li>
</ul>
<p class="hint">${s.landingHint}</p>
<div class="ep"><span>${s.landingEndpoint}</span><code>${endpoint}</code></div>
</section></main></body></html>`);
	}
}
