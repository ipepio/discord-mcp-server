/**
 * Page kit for the hub's browser surfaces.
 *
 * Tokens and card geometry follow one neutral reference system: light palette, `system-ui` at
 * 0.9375rem/1.5, 8px radii, one 400px card centred over a soft radial on the page surface. Values are
 * inlined deliberately, not imported: the hub has no CSS pipeline and must stay one self-contained
 * response.
 *
 * Every user-visible string ships in both interface locales (`HUB_UI_LOCALE`, es by default); the
 * product name and the drawn mark come from the validated brand configuration (`HUB_BRAND_NAME`,
 * `HUB_BRAND_MARK_FILE`), so a third-party deployment renames itself through env only.
 */

export type UiLocale = "es" | "en";

export interface UiStrings {
	readonly landingSub: string;
	readonly landingField: string;
	readonly landingLimited: string;
	readonly landingCta: string;
	readonly landingChipReadonly: string;
	readonly landingChipReadonlyHint: string;
	readonly landingChipScope: string;
	readonly landingChipScopeHint: string;
	readonly landingChipSession: (value: string) => string;
	readonly landingChipSessionHint: string;
	readonly landingHint: string;
	readonly landingEndpoint: string;
	readonly notIdentified: string;
	readonly sessionTitle: string;
	readonly sessionSub: (minutes: number, refreshDays: number) => string;
	readonly accessLabel: string;
	readonly refreshLabel: string;
	readonly refreshDays: string;
	readonly copy: string;
	readonly copied: string;
	readonly sessionHint: string;
	readonly back: string;
	readonly failedTitle: string;
	readonly failedHint: string;
	readonly retry: string;
}

const ES: UiStrings = {
	landingSub: "Consulta el conocimiento de tu servidor desde tu agente.",
	landingField: "Servidor de esta instalación",
	landingLimited: "Acceso limitado a tus permisos",
	landingCta: "Continuar con Discord",
	landingChipReadonly: "Solo lectura",
	landingChipReadonlyHint: "nunca escribe",
	landingChipScope: "1 permiso",
	landingChipScopeHint: "identify",
	landingChipSession: (value) => `Sesión ${value}`,
	landingChipSessionHint: "expiración fija",
	landingHint:
		"Al entrar verás un token de sesión para tu cliente. Si el cliente soporta OAuth, apúntalo al endpoint de abajo y él abrirá el mismo login.",
	landingEndpoint: "Endpoint MCP",
	notIdentified: "Servidor todavía no identificado",
	sessionTitle: "Sesión iniciada",
	sessionSub: (minutes, days) =>
		`Acceso durante ${minutes} minutos; el token de refresco, ${days} días. Trátalos como contraseñas.`,
	accessLabel: "Token de sesión",
	refreshLabel: "Token de refresco",
	refreshDays: "30 días",
	copy: "Copiar",
	copied: "Copiado ✓",
	sessionHint:
		"Envíalos a tu cliente MCP con <code>Authorization: Bearer &lt;token&gt;</code>. Cuando el acceso caduque, vuélvete a autenticar aquí.",
	back: "Volver al inicio",
	failedTitle: "No se pudo iniciar sesión",
	failedHint:
		"Si tu cuenta no pertenece a este servidor de Discord, el hub no puede darte acceso: la membresía es la puerta.",
	retry: "Reintentar"
};

const EN: UiStrings = {
	landingSub: "Query your server's knowledge from your agent.",
	landingField: "This installation's server",
	landingLimited: "Access limited to your permissions",
	landingCta: "Continue with Discord",
	landingChipReadonly: "Read-only",
	landingChipReadonlyHint: "never writes",
	landingChipScope: "1 scope",
	landingChipScopeHint: "identify",
	landingChipSession: (value) => `${value} session`,
	landingChipSessionHint: "fixed expiry",
	landingHint:
		"Inside you will find a session token for your client. If the client supports OAuth, point it at the endpoint below and it will open the same login.",
	landingEndpoint: "MCP endpoint",
	notIdentified: "Server not yet identified",
	sessionTitle: "Signed in",
	sessionSub: (minutes, days) =>
		`Access for ${minutes} minutes; the refresh token, ${days} days. Treat them like passwords.`,
	accessLabel: "Session token",
	refreshLabel: "Refresh token",
	refreshDays: "30 days",
	copy: "Copy",
	copied: "Copied ✓",
	sessionHint:
		"Send them to your MCP client with <code>Authorization: Bearer &lt;token&gt;</code>. When access expires, sign in here again.",
	back: "Back to the start",
	failedTitle: "Sign-in failed",
	failedHint:
		"If your account does not belong to this Discord server, the hub cannot grant you access: membership is the gate.",
	retry: "Try again"
};

export function stringsFor(locale: UiLocale): UiStrings {
	return locale === "en" ? EN : ES;
}

export const GOVERNOR_STYLE = `
:root{
color-scheme:light;
--surface-page:#f5f7fa;--surface-raised:#ffffff;--surface-input:#f5f7fa;
--text-primary:#16324a;--text-secondary:#3d5068;--text-muted:#5c6b80;
--border-subtle:#e8ecf0;--border-strong:#d8dee6;
--action:#1e6fd9;--action-hover:#185bb5;
--accent:#00adb5;--brand-a:#00d7d7;--brand-b:#241dba;
--radius-sm:4px;--radius-md:6px;--radius-lg:8px;--radius-xl:12px;
--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:20px;--space-6:24px;--space-8:32px;
--shadow-card:0 8px 24px rgba(0,0,0,.12);
--font-sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--font-size-base:.9375rem;--line-base:1.5;
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--surface-page);color:var(--text-primary);font-family:var(--font-sans);
font-size:var(--font-size-base);line-height:var(--line-base);-webkit-font-smoothing:antialiased}
h1,h2,p{margin:0}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.auth-page{display:grid;place-items:center;min-height:100vh;padding:var(--space-8) var(--space-4);
background:radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--action) 7%,transparent) 0%,transparent 60%),var(--surface-page)}
.auth-card{width:100%;max-width:400px;padding:var(--space-8) var(--space-6) var(--space-6);background:var(--surface-raised);
border:1px solid var(--border-subtle);border-radius:var(--radius-lg);box-shadow:var(--shadow-card)}
.brand{display:grid;justify-items:center;gap:var(--space-3);margin-bottom:var(--space-6)}
.brand__mark{width:84px;height:84px;display:grid;place-items:center}
.brand__mark svg{width:84px;height:84px;display:block}
.brand__word{font-weight:650;letter-spacing:-.01em;font-size:1.0625rem}
.auth-title{font-size:1.0625rem;font-weight:650;letter-spacing:-.01em;text-align:center;margin-bottom:var(--space-1)}
.auth-sub{font-size:.8125rem;color:var(--text-muted);text-align:center;margin-bottom:var(--space-6)}
.server{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-3);margin-bottom:var(--space-5);
background:var(--surface-input);border:1px solid var(--border-strong);border-radius:var(--radius-md);font-size:.8125rem;color:var(--text-secondary)}
.server__avatar{width:26px;height:26px;border-radius:var(--radius-sm);flex:0 0 auto;display:grid;place-items:center;
background:linear-gradient(140deg,var(--brand-a),var(--brand-b));color:#fff;font-size:10.5px;font-weight:700}
.server__meta{display:grid;line-height:1.25}
.server__meta strong{color:var(--text-primary);font-weight:600;font-size:.8125rem}
.server__meta small{color:var(--text-muted);font-size:.6875rem}
.chips{display:flex;gap:var(--space-2);margin:var(--space-4) 0 0;padding:0;list-style:none}
.chips li{flex:1;padding:var(--space-2);background:var(--surface-input);border:1px solid var(--border-subtle);border-radius:var(--radius-md)}
.chips b{display:block;font-size:.7rem;color:var(--text-primary);font-weight:600}
.chips span{font-size:.6875rem;color:var(--text-muted)}
.chips code{font-size:.6875rem}
.ep{margin:var(--space-4) 0 0;padding:var(--space-2) var(--space-3);background:var(--surface-input);
border:1px dashed var(--border-strong);border-radius:var(--radius-md);text-align:left}
.ep span{display:block;font-size:.6875rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:var(--space-1)}
.ep code{font-size:.75rem;color:var(--text-secondary);overflow-wrap:anywhere}
.btn{display:flex;align-items:center;justify-content:center;gap:var(--space-2);width:100%;padding:var(--space-3);
border:0;border-radius:var(--radius-md);background:var(--action);color:#fff;font:inherit;font-weight:600;cursor:pointer;
text-decoration:none;transition:background-color .14s ease}
.btn:hover{background:var(--action-hover)}
.btn:focus-visible{outline:2px solid var(--action);outline-offset:2px}
.token{white-space:pre-wrap;word-break:break-all;margin:0 0 var(--space-3);padding:var(--space-3);background:var(--surface-input);
border:1px solid var(--border-strong);border-radius:var(--radius-md);font-size:.75rem;line-height:1.6;color:var(--text-secondary);max-height:140px;overflow:auto}
.hint{font-size:.75rem;color:var(--text-muted);line-height:1.55;margin-top:var(--space-3)}
.hint code{font-size:.7rem}
.link{display:inline-block;margin-top:var(--space-4);font-size:.8125rem;font-weight:600;color:var(--action);text-decoration:none}
.link:hover{text-decoration:underline}
.label{display:block;font-size:.75rem;font-weight:600;color:var(--text-secondary);margin-bottom:var(--space-1)}
@media(prefers-reduced-motion:reduce){.btn{transition:none}}
`;

/** The built-in drawing: a neutral hub emblem (one center node, three guild nodes), never a brand logo. */
const BUILTIN_MARK = `<svg viewBox="0 0 100 100" role="presentation" focusable="false">
<defs>
<linearGradient id="gm1" gradientUnits="userSpaceOnUse" x1="10" y1="90" x2="90" y2="10"><stop offset="0" stop-color="#00D7D7"/><stop offset="1" stop-color="#241DBA"/></linearGradient>
</defs>
<g fill="url(#gm1)">
<circle cx="50" cy="50" r="13"/>
<circle cx="50" cy="14" r="8"/>
<circle cx="81.4" cy="68" r="8"/>
<circle cx="18.6" cy="68" r="8"/>
</g>
<g stroke="url(#gm1)" stroke-width="6" stroke-linecap="round" fill="none">
<path d="M50 22 V37"/>
<path d="M38.7 56.5 L25.5 64"/>
<path d="M61.3 56.5 L74.5 64"/>
</g>
</svg>`;

/** The configured mark, or the product's built-in drawing. The mark never carries a badge or wordmark. */
export function brand(markSvg?: string): string {
	return `<div class="brand"><span class="brand__mark">${markSvg ?? BUILTIN_MARK}</span></div>`;
}

/** Two-letter badge from a guild name; neutral when nothing is identified. */
export function initials(guildName: string | undefined): string {
	const words = (guildName ?? "")
		.replace(/[^\p{L}\p{N} ]+/gu, " ")
		.split(/\s+/)
		.filter((word) => word.length > 0);
	const significant = words.filter((word) => !/^el$|^la$|^los$|^las$|^de$|^del$/i.test(word));
	const first = significant[0] ?? "";
	const last = significant.length > 1 ? (significant[significant.length - 1] ?? first) : first;
	const letters = [...new Set([first, last].map((word) => [...word][0] ?? "").filter(Boolean))];
	return escapeHtml(letters.join("").slice(0, 2).toUpperCase() || "GH");
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
