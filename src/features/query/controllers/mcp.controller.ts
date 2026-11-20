import { Controller, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { McpAuthenticationGuard } from "../../authorization/index.js";
import type { AuthenticatedMcpRequest } from "../../authorization/index.js";
import type { QueryToolsAdapter } from "../mcp/query-tools.adapter.js";
import { QueryAuthenticationError } from "../mcp/query-tools.adapter.js";
import { QUERY_TOOLS_ADAPTER_TOKEN } from "../query.tokens.js";

interface McpResponse {
	status(code: number): McpResponse;
	json(body: unknown): void;
	end(): void;
}

@Controller()
@UseGuards(McpAuthenticationGuard)
export class McpController {
	public constructor(@Inject(QUERY_TOOLS_ADAPTER_TOKEN) private readonly adapter: QueryToolsAdapter) {}

	@Post("mcp")
	public async handle(@Req() request: AuthenticatedMcpRequest, @Res() response: McpResponse): Promise<void> {
		const principal = request.authorizationPrincipal;
		if (!principal) throw new QueryAuthenticationError();
		const result = await this.adapter.handle(request.body, {
			userId: principal.userId,
			sessionId: principal.sessionId,
			expiresAt: principal.expiresAt
		});
		if (result === undefined) response.status(202).end();
		else response.status(200).json(result);
	}
}
