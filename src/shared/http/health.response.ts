import { ApiProperty } from "@nestjs/swagger";

/** Auxiliary health output contract. Deliberately exposes no configuration, database or version detail. */
export class HealthResponse {
	@ApiProperty({
		description: "Process liveness state. This is not database readiness.",
		enum: ["ok"],
		example: "ok"
	})
	/** Literal contract: this response has exactly one state (asserted by tests/app.smoke.test.ts). */
	public readonly status = "ok" as const;
}
