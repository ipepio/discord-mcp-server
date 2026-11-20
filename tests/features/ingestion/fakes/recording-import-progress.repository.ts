import type { DiscordIdentifier } from "../../../../src/features/ingestion/models/domain/discord-identifier.js";
import type { ChannelImportProgress } from "../../../../src/features/ingestion/models/domain/import-progress.js";
import type { ImportProgressRepository } from "../../../../src/features/ingestion/repositories/import-progress.repository.js";

/**
 * The import ledger contract's test double: a map that answers the same four questions the table does, in the
 * same shapes.
 *
 * It exists so a unit test can exercise a command's orchestration — what it loads, when it writes, what it prunes
 * — without a server (docs/architecture/testing.md: the doubles prove call shape and control flow, the
 * integration suite proves SQL behaviour against real rows). Every rule a database enforces is therefore
 * deliberately *absent* here: no `bigint` parsing, no CHECK constraint, no transaction. A test that needs those
 * reads the real table through `PostgresImportProgressRepository`.
 *
 * `saveAll` records each call as it arrived, which is how a test pins the bounded-write rule: one call per
 * channel, never one per page.
 */
export class RecordingImportProgressRepository implements ImportProgressRepository {
	private readonly rows = new Map<string, ChannelImportProgress>();

	/** Every `saveAll` call, in order, with the entries as handed in. */
	public readonly saves: (readonly ChannelImportProgress[])[] = [];

	public readonly forgetCalls: (readonly DiscordIdentifier[])[] = [];

	public loadAll = async (guildId: DiscordIdentifier): Promise<readonly ChannelImportProgress[]> => {
		void guildId;
		return [...this.rows.values()];
	};

	public saveAll = async (guildId: DiscordIdentifier, entries: readonly ChannelImportProgress[]): Promise<void> => {
		void guildId;
		this.saves.push(entries);
		for (const entry of entries) {
			this.rows.set(entry.channelId, entry);
		}
	};

	public outstanding = async (
		guildId: DiscordIdentifier,
		now: Date,
		limit: number
	): Promise<readonly ChannelImportProgress[]> => {
		void guildId;
		return [...this.rows.values()]
			.filter(
				(entry) =>
					entry.status !== "complete" &&
					(entry.nextAttemptAt === null || entry.nextAttemptAt.getTime() <= now.getTime())
			)
			.slice(0, limit);
	};

	public forgetChannels = async (
		guildId: DiscordIdentifier,
		channelIds: readonly DiscordIdentifier[]
	): Promise<number> => {
		void guildId;
		this.forgetCalls.push(channelIds);
		let dropped = 0;
		for (const channelId of channelIds) {
			if (this.rows.delete(channelId)) dropped += 1;
		}
		return dropped;
	};

	/** Seed a stored row without recording a save: the state a previous process left behind. */
	public seed(entry: ChannelImportProgress): void {
		this.rows.set(entry.channelId, entry);
	}

	public stored(channelId: DiscordIdentifier): ChannelImportProgress | null {
		return this.rows.get(channelId) ?? null;
	}
}
