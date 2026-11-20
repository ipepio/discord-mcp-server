import { Inject, Injectable } from "@nestjs/common";
import type { NestMiddleware } from "@nestjs/common";
import { APP_CONFIG_TOKEN } from "../../../shared/config/config.tokens.js";
import type { AppConfig } from "../../../shared/config/app-config.interface.js";
import { authorizationRateLimits } from "../../../shared/config/authorization-config.js";
import { APP_LOGGER_TOKEN } from "../../../shared/logging/logging.tokens.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { AUTHORIZATION_RATE_LIMITER_TOKEN } from "../authorization.tokens.js";
import { RATE_LIMIT_KEY_SEPARATOR } from "../gateways/rate-limit.gateway.js";
import type { RateLimiterGateway } from "../gateways/rate-limit.gateway.interface.js";
import { resolveRateLimitRule } from "../models/domain/rate-limit-policy.js";
import { clientAddress } from "./client-address.js";

export interface RateLimitRequest {
	readonly method: string;
	readonly path: string;
	readonly headers: Readonly<Record<string, unknown>>;
	readonly socket?: { readonly remoteAddress?: unknown };
}

export interface RateLimitResponse {
	readonly setHeader: (name: string, value: string) => unknown;
	readonly status: (code: number) => RateLimitResponse;
	readonly json: (body: unknown) => void;
}

export type RateLimitNext = (error?: unknown) => void;

/**
 * Applied to the five public surfaces from `AuthorizationModule`: the four OAuth endpoints plus
 * `/mcp`. Paths outside the policy always pass through; a refused request gets a safe 429 and only
 * its outcome code and address reach the log.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware<RateLimitRequest, RateLimitResponse> {
	public constructor(
		@Inject(AUTHORIZATION_RATE_LIMITER_TOKEN) private readonly limiter: RateLimiterGateway,
		@Inject(APP_CONFIG_TOKEN) private readonly app: AppConfig,
		@Inject(APP_LOGGER_TOKEN) private readonly logger?: AppLogger
	) {}

	public readonly use = (request: RateLimitRequest, response: RateLimitResponse, next: RateLimitNext): void => {
		const rule = resolveRateLimitRule(
			authorizationRateLimits(this.app.authorization),
			request.method,
			request.path
		);
		if (!rule) {
			next();
			return;
		}
		const address = clientAddress(request);
		const decision = this.limiter.take(`${rule.route}${RATE_LIMIT_KEY_SEPARATOR}${address}`);
		if (decision.allowed) {
			next();
			return;
		}
		try {
			this.logger?.warn("authorization request throttled", { code: "rate_limited", ip: address });
		} catch {
			/* A broken log sink never changes the refusal. */
		}
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("Retry-After", String(decision.retryAfterSeconds));
		response.status(429).json({ error: "too_many_requests" });
	};
}
