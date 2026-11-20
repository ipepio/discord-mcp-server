# Shared infrastructure and external gateways

`shared` contains technical capabilities, not business concepts that happen to be used twice.
A feature owns its business logic even when other features consume it.

## What belongs where

| Concern | Placement |
| --- | --- |
| Environment parsing and technical settings | `shared/config` |
| Correlation/request context | `shared/context` |
| Logger contract, structured logger adapter | `shared/logging` |
| HTTP transport defaults and timeout plumbing | `shared/http` |
| Pool lifecycle and transaction infrastructure | `shared/persistence` |
| Mapping application errors to HTTP | `shared/errors` |
| External API operations and their DTOs | Owning feature's `gateways` and models |
| Pricing, eligibility, reservation or other business rule | Owning feature's domain/use case |
| Business workflow spanning several features | Explicitly owned application use case |

Do not create `CommonService`, `BaseService`, `utils.ts` or a generic helpers bucket to avoid deciding
ownership. A tiny pure technical helper can live with the capability it supports. Extract a shared
abstraction only when the shared responsibility is understood, not from superficial duplication.

## Gateway pattern

A gateway encapsulates the external system's HTTP protocol, authentication, endpoints and wire DTOs.
Use a narrow contract at the application seam when a use case needs substitution. Do not expose
Axios responses, raw fetch responses or external payloads as domain results.

Configure timeouts explicitly. Retry only identified transient failures when replay is safe, with
bounded attempts and backoff. Never automatically retry non-idempotent writes without a safe strategy.
Validate external payloads before relying on them; TypeScript generics do not validate runtime data.
Map expected external absence/conflicts deliberately and preserve unexpected failures for the boundary.

Authentication credentials stay in the gateway's infrastructure/configuration path, not in commands.
Do not log authorization headers, passwords, tokens or full sensitive response bodies. Circuit
breakers, caches and queues are optional project decisions, not mandatory template features.

## Nest composition

Follow the source repository's explicit DI convention: string constants for tokens, `@Inject(TOKEN)`
on injected constructor parameters or factory providers with explicit `inject` arrays. Class-token
parameters also need explicit resolution when `emitDecoratorMetadata` is disabled. Do not rely on
a TypeScript type annotation to resolve a runtime dependency.

Feature modules bind use cases to their repository/gateway implementations. The application module
composes feature and infrastructure modules. Keep global modules limited to truly application-wide
infrastructure; a business feature should not become global to simplify an import.

Register **instances resolved by the container**, not arrays of class constructors masquerading as
handlers. Use focused factories when wiring plain framework-free use cases. Keep Nest decorators
out of domain models and commands/queries.

## Configuration and lifecycle

Validate required configuration once at startup. Parse booleans, numbers, URLs and bounds explicitly;
no scattered `process.env` reads or unvalidated `Object.assign` into a typed config class.
Document each required variable and safe example when executable setup is authorized. Never commit
real credentials. Separate migration credentials from ordinary runtime credentials when appropriate.

Use structured logging through a common logger contract, with correlation context. Avoid competing
Nest/custom logger types and application `console.log` calls. Redact confidential fields and define
logging retention/exposure for the deployment. Close pools and consumers on shutdown; cap concurrent
work and define failure handling if the project later introduces background processing.
