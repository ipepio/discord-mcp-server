import type { OnApplicationShutdown } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL_TOKEN } from "./persistence.tokens.js";

/** Closes the managed pool when the application shuts down (docs/architecture/shared.md). */
@Injectable()
export class PgPoolShutdown implements OnApplicationShutdown {
	public constructor(@Inject(PG_POOL_TOKEN) private readonly pool: Pool) {}

	public async onApplicationShutdown(): Promise<void> {
		await this.pool.end();
	}
}
