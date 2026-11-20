export const INGESTION_CONFIG_TOKEN = "INGESTION_CONFIG_TOKEN";
export const INGESTION_LOGGER_TOKEN = "INGESTION_LOGGER_TOKEN";
export const INGESTION_MESSAGE_STORE_TOKEN = "INGESTION_MESSAGE_STORE_TOKEN";
export const INGESTION_RECORD_COMMAND_TOKEN = "INGESTION_RECORD_COMMAND_TOKEN";
export const INGESTION_EDIT_COMMAND_TOKEN = "INGESTION_EDIT_COMMAND_TOKEN";
export const INGESTION_DELETE_COMMAND_TOKEN = "INGESTION_DELETE_COMMAND_TOKEN";
export const INGESTION_EXCLUDE_COMMAND_TOKEN = "INGESTION_EXCLUDE_COMMAND_TOKEN";
export const INGESTION_BACKFILL_COMMAND_TOKEN = "INGESTION_BACKFILL_COMMAND_TOKEN";
/** R14's durable import ledger (`import_channel_progress`), behind its repository contract. */
export const INGESTION_PROGRESS_REPOSITORY_TOKEN = "INGESTION_PROGRESS_REPOSITORY_TOKEN";
/** One bounded catch-up tick: which channels are outstanding and how far each one advances (R14). */
export const INGESTION_CATCH_UP_COMMAND_TOKEN = "INGESTION_CATCH_UP_COMMAND_TOKEN";
/** R14's scheduler. Inert when `INGESTION_CATCH_UP_ENABLED=false`, and never awaited by a request path. */
export const INGESTION_CATCH_UP_WORKER_TOKEN = "INGESTION_CATCH_UP_WORKER_TOKEN";
/**
 * `BackfillChannelAccessCommand` — the one-channel backfill a gained channel access starts. Composed onto
 * guild-state's outbound access-trigger port by the application lifecycle, never called by the event path.
 */
export const INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN = "INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN";
export const INGESTION_IMPORT_COMMAND_TOKEN = "INGESTION_IMPORT_COMMAND_TOKEN";
export const INGESTION_RESYNC_COMMAND_TOKEN = "INGESTION_RESYNC_COMMAND_TOKEN";
export const INGESTION_EVENT_SUBSCRIPTION_TOKEN = "INGESTION_EVENT_SUBSCRIPTION_TOKEN";
