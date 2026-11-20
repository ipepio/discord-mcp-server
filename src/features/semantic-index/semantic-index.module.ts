import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import type { EnvSource } from "../../shared/config/app-config.interface.js";
import { LoggingModule } from "../../shared/logging/logging.module.js";
import { APP_LOGGER_TOKEN } from "../../shared/logging/logging.tokens.js";
import type { AppLogger } from "../../shared/logging/logger.interface.js";
import { PersistenceModule } from "../../shared/persistence/persistence.module.js";
import { PG_POOL_TOKEN } from "../../shared/persistence/persistence.tokens.js";
import { EmbedPendingMessagesCommand } from "./commands/embed-pending-messages.command.js";
import { loadEmbeddingConfig } from "./config/embedding-config.validator.js";
import { loadFullTextLanguage } from "./config/full-text-language.validator.js";
import { EmbeddingPipelineWorker } from "./embedding-pipeline.worker.js";
import type { EmbeddingProvider } from "./gateways/embedding-provider.interface.js";
import { OpenAiEmbeddingGateway } from "./gateways/openai-embedding.gateway.js";
import { HYBRID_RETRIEVAL } from "./queries/hybrid-retrieval.interface.js";
import { RetrieveHybridCandidatesQuery } from "./queries/retrieve-hybrid-candidates.query.js";
import type { EmbeddingStoreRepository } from "./repositories/embedding-store.repository.js";
import type { FullTextCandidatesRepository } from "./repositories/full-text-candidates.repository.js";
import { PostgresEmbeddingStoreRepository } from "./repositories/postgres-embedding-store.repository.js";
import type { EmbeddingSqlExecutor } from "./repositories/postgres-embedding-store.repository.js";
import { PostgresFullTextCandidatesRepository } from "./repositories/postgres-full-text-candidates.repository.js";
import {
	EMBEDDING_PROVIDER,
	EMBEDDING_STORE,
	FULL_TEXT_CANDIDATES,
	EMBEDDING_BATCH_COMMAND,
	EMBEDDING_WORKER
} from "./semantic-index.tokens.js";

@Module({})
export class SemanticIndexModule {
	/** Like the sibling features, deployment opts in at the composition root; no global business module. */
	static register(env: EnvSource): DynamicModule {
		// Synchronous validation precedes container instantiation, pool activity, or provider construction.
		const config = loadEmbeddingConfig(env);
		const language = loadFullTextLanguage(env);
		return {
			module: SemanticIndexModule,
			imports: [LoggingModule, PersistenceModule],
			providers: [
				{ provide: EMBEDDING_PROVIDER, useFactory: () => new OpenAiEmbeddingGateway(config) },
				{
					provide: EMBEDDING_STORE,
					inject: [PG_POOL_TOKEN],
					useFactory: (sql: EmbeddingSqlExecutor) => new PostgresEmbeddingStoreRepository(sql)
				},
				{
					provide: FULL_TEXT_CANDIDATES,
					inject: [PG_POOL_TOKEN],
					useFactory: (sql: EmbeddingSqlExecutor) => new PostgresFullTextCandidatesRepository(sql, language)
				},
				{
					provide: EMBEDDING_BATCH_COMMAND,
					inject: [EMBEDDING_STORE, EMBEDDING_PROVIDER, APP_LOGGER_TOKEN],
					useFactory: (store: EmbeddingStoreRepository, provider: EmbeddingProvider, logger: AppLogger) =>
						new EmbedPendingMessagesCommand(
							store,
							provider,
							logger.withContext({ feature: "semantic-index" })
						)
				},
				{
					provide: EMBEDDING_WORKER,
					inject: [EMBEDDING_BATCH_COMMAND, APP_LOGGER_TOKEN],
					useFactory: (command: EmbedPendingMessagesCommand, logger: AppLogger) =>
						new EmbeddingPipelineWorker(command, logger.withContext({ feature: "semantic-index" }))
				},
				{
					provide: HYBRID_RETRIEVAL,
					inject: [FULL_TEXT_CANDIDATES, EMBEDDING_STORE, EMBEDDING_PROVIDER],
					useFactory: (
						fts: FullTextCandidatesRepository,
						store: EmbeddingStoreRepository,
						provider: EmbeddingProvider
					) => new RetrieveHybridCandidatesQuery(fts, store, provider)
				}
			],
			exports: [HYBRID_RETRIEVAL]
		};
	}
}
