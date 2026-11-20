import { Controller, Get, Headers, Inject, Query, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../../../shared/config/app-config.interface.js";
import { APP_CONFIG_TOKEN } from "../../../shared/config/config.tokens.js";
import { brandOrDefault } from "../../../shared/config/brand-config.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { APP_LOGGER_TOKEN } from "../../../shared/logging/logging.tokens.js";
import { BeginLoginCommand } from "../commands/begin-login.command.js";
import { ExchangeAuthorizationCodeCommand } from "../commands/exchange-authorization-code.command.js";
import { FIRST_PARTY_CLIENT_ID } from "../bootstrap/first-party-client.seeder.js";
import { AUTHORIZATION_PUBLIC_BASE_URL_TOKEN } from "./mcp-authentication.guard.js";
import { GOVERNOR_STYLE, brand, escapeHtml, stringsFor } from "./page-kit.js";

const COOKIE = "hub_login";
const COOKIE_MAX_AGE_SECONDS = 600;

export interface LoginResponse {
	readonly setHeader: (name: string, value: string) => void;
	readonly status: (code: number) => LoginResponse;
	readonly type: (value: string) => LoginResponse;
	readonly send: (body: string) => void;
}

/** Browser sign-in for people: `/login` starts the Discord flow, `/login/callback` shows the hub session. */
@ApiExcludeController()
@Controller()
export class FirstPartyLoginController {
	public constructor(
		@Inject(BeginLoginCommand) private readonly begin: BeginLoginCommand,
		@Inject(ExchangeAuthorizationCodeCommand) private readonly exchange: ExchangeAuthorizationCodeCommand,
		@Inject(AUTHORIZATION_PUBLIC_BASE_URL_TOKEN) private readonly publicBaseUrl: string,
		@Inject(APP_CONFIG_TOKEN) private readonly config?: AppConfig,
		@Inject(APP_LOGGER_TOKEN) private readonly logger?: AppLogger
	) {}

	/** This page's one link starts the Discord SSO with the hub's own first-party client. */
	@Get("login")
	public async start(@Res() response: LoginResponse): Promise<void> {
		const verifier = randomBytes(48).toString("base64url");
		const state = randomBytes(24).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		try {
			const result = await this.begin.execute({
				clientId: FIRST_PARTY_CLIENT_ID,
				redirectUri: this.redirectUri(),
				responseType: "code",
				state,
				codeChallenge: challenge,
				codeChallengeMethod: "S256"
			});
			const secure = this.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
			response.setHeader(
				"Set-Cookie",
				`${COOKIE}=${encodeURIComponent(`${verifier}.${state}`)}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`
			);
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("Location", result.redirectUrl);
			response.status(302);
			response.type("text/plain; charset=utf-8");
			response.send("");
		} catch (failure) {
			this.fail(response, failure);
		}
	}

	@Get("login/callback")
	public async callback(
		@Query() query: unknown,
		@Headers("cookie") cookieHeader: string | undefined,
		@Res() response: LoginResponse
	): Promise<void> {
		const input = typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
		const state = text(input["state"]);
		const code = text(input["code"]);
		try {
			if (!state || !code) throw new Error("The login response is incomplete; start again.");
			const cookie = readCookie(cookieHeader);
			if (!cookie) throw new Error("La sesión de este navegador caducó; vuelve a iniciar sesión.");
			if (cookie.state !== state) throw new Error("El estado del login no corresponde a este navegador.");
			// Discord already completed the login at /oauth/discord/callback, which redirected here with the
			// hub's own authorization code bound to this client and redirect URI. Only the exchange remains.
			const session = await this.exchange.execute({
				grantType: "authorization_code",
				clientId: FIRST_PARTY_CLIENT_ID,
				redirectUri: this.redirectUri(),
				code,
				codeVerifier: cookie.verifier
			});
			this.renderTokens(response, session);
		} catch (failure) {
			this.fail(response, failure);
		}
	}

	private renderTokens(
		response: LoginResponse,
		session: { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number }
	): void {
		const { name, locale } = brandOrDefault(this.config?.brand);
		const s = stringsFor(locale);
		const minutes = Math.max(1, Math.round(session.expiresIn / 60));
		const days = Math.max(1, Math.round(session.refreshExpiresIn / 86_400));
		this.sendPage(
			response,
			200,
			`<!doctype html><html lang="${locale}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>${s.sessionTitle} — ${escapeHtml(name)}</title>
<style>${GOVERNOR_STYLE}</style></head><body><main class="auth-page"><section class="auth-card">
${brand(brandOrDefault(this.config?.brand).markSvg)}
<h1 class="auth-title">${s.sessionTitle}</h1>
<p class="auth-sub">${s.sessionSub(minutes, days)}</p>
<label class="label" for="tk" id="first-party-access">${s.accessLabel}</label>
<pre class="token" id="tk">${escapeHtml(session.accessToken)}</pre>
<button class="btn" type="button" data-copy="tk" data-label="${s.copy}" data-done="${s.copied}">${s.copy}</button>
<label class="label" for="rt" id="first-party-refresh">${s.refreshLabel}</label>
<pre class="token" id="rt">${escapeHtml(session.refreshToken)}</pre>
<button class="btn" type="button" data-copy="rt" data-label="${s.copy}" data-done="${s.copied}">${s.copy}</button>
<p class="hint">${s.sessionHint}</p>
<a class="link" href="/">${s.back}</a>
</section></main>
<script>(function(){var buttons=document.querySelectorAll("button[data-copy]");
for(var i=0;i<buttons.length;i++){(function(b){var t=document.getElementById(b.getAttribute("data-copy")||"");if(!t)return;
var label=b.getAttribute("data-label")||"Copy";var done=b.getAttribute("data-done")||label;var ok=function(){b.textContent=done;setTimeout(function(){b.textContent=label;},1600);};
b.addEventListener("click",function(){var v=t.textContent||"";
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(ok,function(){ok();});}else{ok();}});})(buttons[i]);}})();</script>
</body></html>`
		);
	}

	private fail(response: LoginResponse, failure: unknown): void {
		const { name, locale } = brandOrDefault(this.config?.brand);
		const s = stringsFor(locale);
		const message = failure instanceof Error ? failure.message : "No se pudo completar el inicio de sesión.";
		this.logger?.warn?.(`first-party login refused: ${message.slice(0, 120)}`);
		this.sendPage(
			response,
			400,
			`<!doctype html><html lang="${locale}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>${s.failedTitle} — ${escapeHtml(name)}</title>
<style>${GOVERNOR_STYLE}</style></head><body><main class="auth-page"><section class="auth-card">
${brand(brandOrDefault(this.config?.brand).markSvg)}<h1 class="auth-title">${s.failedTitle}</h1>
<p class="auth-sub">${escapeHtml(message)}</p>
<p class="hint">${s.failedHint}</p>
<a class="link" href="/login">${s.retry}</a>
</section></main></body></html>`
		);
	}

	private redirectUri(): string {
		return `${this.publicBaseUrl.replace(/\/+$/, "")}/login/callback`;
	}

	private sendPage(response: LoginResponse, status: number, body: string): void {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
		);
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.type("text/html; charset=utf-8");
		response.status(status);
		response.send(body);
	}
}

/** `hub_login` carries `verifier.state`; both halves are base64url, so one dot separates them. */
function readCookie(header: string | undefined): { verifier: string; state: string } | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key !== COOKIE) continue;
		const value = decodeURIComponent(rest.join("="));
		const index = value.indexOf(".");
		if (index <= 0) return null;
		return { verifier: value.slice(0, index), state: value.slice(index + 1) };
	}
	return null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
