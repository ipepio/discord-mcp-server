/**
 * R15: the connect-time onboarding text. Composed per connection from the declared brand (name and
 * interface locale) and the Guild identity read from guild-state's registry contract — never cached and
 * never duplicated per transport (docs/features/query.md R15, O10).
 *
 * The text is a contract, not a marketing string: every fact R15 requires lives here, and the named test
 * `instructions-teach-agent` fails if one goes missing. It carries no Requester identity, no channel id and
 * no message content (R1, R3, R15).
 */

/** The interface languages the shared brand configuration validates today (`HUB_UI_LOCALE`). */
export type InstructionsLocale = "es" | "en";

/** R8's unidentified-Guild wording, kept verbatim in both locales so a client can still tell it apart. */
export const UNIDENTIFIED_GUILD_WORDING = "Guild not yet identified";

export interface ConnectionInstructions {
	/** The configured `HUB_BRAND_NAME` (R8, Contracts "Brand contract"). */
	readonly brandName: string;
	/** The configured interface locale; O10's English fallback applies when it is unset. */
	readonly locale?: InstructionsLocale | undefined;
	/** The Guild name from guild-state's registry, absent while the registry is not current (R8, R11). */
	readonly guildName?: string | undefined;
	/** The Guild id from guild-state's registry status, absent when it cannot be read (R8). */
	readonly guildId?: string | undefined;
}

interface WakeupText {
	/** Identifies which server this is: brand plus the Guild name and id, or R8's unnamed wording. */
	readonly identity: (name: string | undefined, guildId: string | undefined) => string;
	readonly firstConnect: string;
	readonly novelty: string;
	readonly history: string;
	/** R15's mirror-scope block (amended 2026-11-12): a short list is the mirror scope, not a defect. */
	readonly mirrorScope: string;
	readonly honesty: string;
}

const EN: WakeupText = {
	identity: (name, guildId) => `Identity: Guild "${name}" (Guild id ${guildId}).`,
	firstConnect:
		"First connect: this MCP surface is OAuth-protected. Discover the authorization server from the " +
		"protected-resource metadata advertised by the 401 response (WWW-Authenticate: Bearer " +
		'resource_metadata="...") and then ask the human to complete the Discord browser login. The login is ' +
		"the human's step: present the link and wait for them. Never retry the request, re-probe the URL or " +
		"invent a result while they log in.",
	novelty:
		'Novelty: to answer "what is new", call get_recent_activity. If the person named neither a ' +
		'channel/category nor a time window, ask them before calling — "a summary of the last 15 days", ' +
		'"everything", "news in dev-general", "since my last message". The hub keeps no per-user read state, ' +
		'so novelty is always a time or anchor window you agree with the person; "everything" means since ' +
		'the epoch boundary (since: "1970-01-01T00:00:00Z").',
	history:
		"History: history is recent-first — page backward with the cursor and pass from/to for an explicit " +
		"range. get_message_context reads the discussion around one message, search_messages finds a topic, " +
		"and list_channels lists only the channels and threads that both the person and the bot can see.",
	// R15's required wording, verbatim: a subset on purpose, not a pagination defect, verified with the tool
	// that reports the count. It exists because a client read a short page as a broken one (S3).
	mirrorScope:
		"Mirror scope: this hub mirrors only part of the Guild — the channels and threads that both the " +
		"person and the bot can see. `list_channels` lists a subset on purpose, so a short list is not a " +
		"pagination defect: call `get_hub_status` for the mirror scope (visibleAndMirroredChannelCount) and " +
		"the registry status before concluding that something is missing.",
	honesty:
		"Honesty: results are limited by the person's Discord permissions and by what the bot mirrors; a " +
		"missing channel is not reported as nonexistent, and no tool mutates anything."
};

const ES: WakeupText = {
	identity: (name, guildId) => `Identidad: Guild "${name}" (Guild id ${guildId}).`,
	firstConnect:
		"Primera conexión: esta superficie MCP está protegida con OAuth. Descubre el servidor de autorización " +
		"en los metadatos de recurso protegido que anuncia la respuesta 401 (WWW-Authenticate: Bearer " +
		'resource_metadata="...") y después pide a la persona que complete el inicio de sesión de Discord en ' +
		"el navegador. Ese inicio de sesión es el paso de la persona: muéstrale el enlace y espera. Nunca " +
		"reintentes la petición, vuelvas a sondear la URL ni inventes un resultado mientras inicia sesión.",
	novelty:
		'Novedad: para responder "qué hay de nuevo", llama a get_recent_activity. Si la persona no indicó ni ' +
		'un canal/categoría ni una ventana de tiempo, pregúntale antes de llamar — "un resumen de los ' +
		'últimos 15 días", "todo", "novedades en dev-general", "desde mi último mensaje". El hub no guarda ' +
		"estado de lectura por usuario, así que la novedad es siempre una ventana de tiempo o un ancla " +
		'acordada con la persona; "todo" significa desde el límite de la época ' +
		'(since: "1970-01-01T00:00:00Z").',
	history:
		"Historial: el historial va de lo más reciente a lo más antiguo — pagina hacia atrás con el cursor y " +
		"usa from/to para un rango explícito. get_message_context lee la conversación alrededor de un " +
		"mensaje, search_messages busca un tema y list_channels solo lista los canales e hilos que la persona " +
		"y el bot pueden ver.",
	// R15 requires the same three facts in every locale: a subset on purpose, not a pagination defect, and
	// `get_hub_status` as the call that reports the mirror scope.
	mirrorScope:
		"Alcance del espejo: este hub replica solo una parte del Guild — los canales e hilos que la persona y " +
		"el bot pueden ver. `list_channels` lista un subconjunto a propósito, así que una lista corta no es " +
		"un fallo de paginación: llama a `get_hub_status` para ver el alcance del espejo " +
		"(visibleAndMirroredChannelCount) y el estado del registro antes de concluir que falta algo.",
	honesty:
		"Honestidad: los resultados están limitados por los permisos de Discord de la persona y por lo que el " +
		"bot replica; un canal ausente no se informa como inexistente y ninguna herramienta modifica nada."
};

/** The identity half: R15 requires name and id, and R8's wording while the Guild is unidentified. */
function identity(text: WakeupText, name: string | undefined, guildId: string | undefined): string {
	return name === undefined || guildId === undefined ? UNIDENTIFIED_GUILD_WORDING : text.identity(name, guildId);
}

export function composeConnectionInstructions(input: ConnectionInstructions): string {
	const locale: InstructionsLocale = input.locale ?? "en";
	const text = locale === "es" ? ES : EN;
	return [
		input.brandName,
		identity(text, input.guildName, input.guildId),
		text.firstConnect,
		text.novelty,
		text.history,
		text.mirrorScope,
		text.honesty
	].join("\n");
}
