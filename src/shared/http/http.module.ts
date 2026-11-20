import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";

/** Auxiliary HTTP transport surface. Per ADR 0004 it carries operational endpoints only. */
@Module({ controllers: [HealthController] })
export class HttpModule {}
