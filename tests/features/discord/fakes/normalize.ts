import { expect } from "vitest";
import { mapRawEvent } from "../../../../src/features/discord/models/mappers/discord-event.mapper.js";
import type { NormalizedDiscordEvent } from "../../../../src/features/discord/models/domain/normalized-discord-event.js";

/** Shared fixture helpers: every mapper test asserts through the registry, not around it. */
export const GUILD_ID = "111111111111111111";
export const FOREIGN_GUILD_ID = "222222222222222222";

/** Maps a raw payload and returns the single normalized event it produced, typed by the caller. */
export function normalizeOne<E extends NormalizedDiscordEvent = NormalizedDiscordEvent>(
	rawEventName: string,
	payload: unknown,
	guildId = GUILD_ID
): E {
	const result = mapRawEvent(rawEventName, payload, guildId);
	if (result.outcome !== "normalized") {
		expect.fail(`${rawEventName} should have normalized, got ${JSON.stringify(result)}`);
	}

	expect(result.events, rawEventName).toHaveLength(1);

	return result.events[0] as E;
}

/** Maps a raw payload and returns every normalized event it produced. */
export function normalizeMany<E extends NormalizedDiscordEvent = NormalizedDiscordEvent>(
	rawEventName: string,
	payload: unknown,
	guildId = GUILD_ID
): readonly E[] {
	const result = mapRawEvent(rawEventName, payload, guildId);
	if (result.outcome !== "normalized") {
		expect.fail(`${rawEventName} should have normalized, got ${JSON.stringify(result)}`);
	}

	return result.events as readonly E[];
}

/** Asserts a payload is rejected and reports the exact field path (R3 boundary). */
export function expectRejected(rawEventName: string, payload: unknown, fieldPath: string): void {
	const result = mapRawEvent(rawEventName, payload, GUILD_ID);
	expect(result, rawEventName).toMatchObject({ outcome: "malformed", fieldPath });
}
