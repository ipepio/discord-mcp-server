import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { HealthResponse } from "./health.response.js";

/**
 * Auxiliary operational endpoint and the only REST controller in this application (ADR 0004 limits the
 * REST surface to health/readiness; MCP is the functional contract). Access classification: public.
 * It reports process liveness only, so it performs no database check and returns no business data.
 */
@ApiTags("operational")
@Controller("health")
export class HealthController {
	@Get()
	@ApiOperation({
		summary: "Liveness probe",
		description: "Public operational endpoint. Returns static liveness; it never exposes configuration or data."
	})
	@ApiResponse({ status: 200, type: HealthResponse, description: "The HTTP process is serving requests." })
	public check(): HealthResponse {
		return new HealthResponse();
	}
}
