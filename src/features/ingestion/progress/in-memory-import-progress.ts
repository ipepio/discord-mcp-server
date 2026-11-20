import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { ChannelImportProgress, ImportProgressLedger } from "../models/domain/import-progress.js";

/**
 * The import ledger as **one run** holds it (docs/features/ingestion.md R3 and R14:
 * "The import is a resumable background job: it tolerates restarts, resumes without duplicating").
 *
 * Since `odd/tasks/ingestion-catchup.md` T1 the source of truth is the `import_channel_progress` table, read and
 * written through `ImportProgressRepository`. This class is what a run keeps in hand while it works: the import
 * loads the Guild's rows into it once, records each channel's outcome as the channel finishes, and derives
 * "what is still outstanding" from it. It is deliberately still a plain map: the ordering, the freezing of
 * recordings and the `null`-means-unknown rule are the in-run contract, and none of them needs SQL.
 *
 * What it is not, any more: a substitute for persistence. A restart no longer empties the ledger — it reloads it
 * from the table — and the measured reason is in the task that added the table: re-walking this Guild's history
 * on every restart re-read 166 866 already-stored messages to discover 6 new ones.
 *
 * Entries are stored as handed in and frozen: a caller that kept mutating the object it recorded would be
 * editing the ledger's history.
 */
export class InMemoryImportProgressLedger implements ImportProgressLedger {
	private readonly entries = new Map<string, ChannelImportProgress>();

	public readonly progressFor = (channelId: DiscordIdentifier): ChannelImportProgress | null =>
		this.entries.get(channelId) ?? null;

	public readonly record = (progress: ChannelImportProgress): void => {
		this.entries.set(progress.channelId, Object.freeze({ ...progress }));
	};

	public readonly forget = (channelId: DiscordIdentifier): boolean => this.entries.delete(channelId);

	public readonly snapshot = (): readonly ChannelImportProgress[] => Object.freeze([...this.entries.values()]);
}
