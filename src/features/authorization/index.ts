/** Identity seam only: consumers never read the session store or resolve Discord identities. */
export { AuthorizationModule } from "./authorization.module.js";
export type { AuthorizationModuleSettings } from "./authorization.module.js";
export { AuthenticateSessionQuery } from "./queries/authenticate-session.query.js";
export type { AuthenticatedPrincipal, AuthenticateSessionResult } from "./queries/authenticate-session.query.js";
export { GetAuthorizationServerMetadataQuery } from "./queries/get-authorization-server-metadata.query.js";
export { McpAuthenticationGuard, AUTHORIZATION_PUBLIC_BASE_URL_TOKEN } from "./controllers/mcp-authentication.guard.js";
export type { AuthenticatedMcpRequest, McpAuthenticationResponse } from "./controllers/mcp-authentication.guard.js";
