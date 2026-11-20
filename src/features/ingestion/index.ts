/** Intentional background-consumer surface: no SQL adapter, repository, content read path or transport. */
export { loadIngestionImportWindow } from "./config/ingestion-config.validator.js";
export { IngestionModule } from "./ingestion.module.js";
export type { IngestionModuleSettings } from "./ingestion.module.js";
export {
	INGESTION_IMPORT_COMMAND_TOKEN,
	INGESTION_EVENT_SUBSCRIPTION_TOKEN,
	INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN
} from "./ingestion.tokens.js";
export {
	IngestionEventSubscription,
	INGESTION_BOUND_EVENT_KINDS
} from "./gateways/ingestion-event-subscription.gateway.js";
export type {
	IngestionEventDisposition,
	IngestionEventSubscriptionDeps
} from "./gateways/ingestion-event-subscription.gateway.js";
export { ImportChannelHistoryCommand } from "./commands/import-channel-history.command.js";
export type {
	ImportChannelHistoryInput,
	ImportChannelHistoryResult
} from "./commands/import-channel-history.command.js";
