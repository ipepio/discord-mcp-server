import { describe, expect, it } from "vitest";
import { RegisterClientCommand } from "../../../src/features/authorization/commands/register-client.command.js";
import { BeginLoginCommand } from "../../../src/features/authorization/commands/begin-login.command.js";
import { GetAuthorizationServerMetadataQuery } from "../../../src/features/authorization/queries/get-authorization-server-metadata.query.js";
import { OAuthController } from "../../../src/features/authorization/controllers/oauth.controller.js";
import { authorizationStoreFixture } from "./authorization-store.fixture.js";

function fixture() {
	const store = authorizationStoreFixture();
	store.findClient.mockResolvedValue({
		clientId: "client",
		redirectUris: ["https://client.example/cb"],
		createdAt: new Date()
	});
	const begin = new BeginLoginCommand({ store, publicBaseUrl: "https://hub.example", discordClientId: "discord-id" });
	const input = {
		clientId: "client",
		redirectUri: "https://client.example/cb",
		responseType: "code",
		state: "opaque + / %",
		codeChallenge: "a".repeat(43),
		codeChallengeMethod: "S256"
	};
	return { store, begin, input };
}

describe("authorization server surface", () => {
	it("serves public metadata without upstream credentials or client lists", () => {
		const query = new GetAuthorizationServerMetadataQuery("https://hub.example");
		expect(query.execute()).toMatchObject({
			issuer: "https://hub.example",
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"]
		});
		expect(query.protectedResource()).toEqual({
			resource: "https://hub.example/mcp",
			authorization_servers: ["https://hub.example"],
			bearer_methods_supported: ["header"]
		});
		expect(JSON.stringify(query.execute())).not.toContain("discord");
	});

	it("registers independent public clients preserving redirect URI bytes", async () => {
		const { store } = fixture();
		const command = new RegisterClientCommand(store);
		const input = {
			redirectUris: ["https://client.example/%2f", "http://127.0.0.1:5555/cb", "http://[::1]:5555/cb"]
		};
		const first = await command.execute(input);
		const second = await command.execute(input);
		expect(first.redirectUris).toEqual(input.redirectUris);
		expect(first.clientId).not.toBe(second.clientId);
		expect(store.insertClient).toHaveBeenCalledTimes(2);
	});

	it.each(
		[
			[],
			["http://client.example/cb"],
			["https://client.example/cb#"],
			["/relative"],
			["https://user:password@client.example/cb"],
			["https://client.example/#fragment"],
			["https://*.client.example/cb"],
			["https://%2a.client.example/cb"]
		].map((redirectUris) => ({ redirectUris }))
	)("rejects invalid redirect sets %j without writes", async ({ redirectUris }) => {
		const { store } = fixture();
		await expect(new RegisterClientCommand(store).execute({ redirectUris })).rejects.toMatchObject({
			code: "invalid_client_metadata"
		});
		expect(store.insertClient).not.toHaveBeenCalled();
	});

	it.each([
		{ grantTypes: ["refresh_token"] },
		{ tokenEndpointAuthMethod: "client_secret_basic" },
		{ responseTypes: ["token"] }
	])("rejects unsupported registration metadata", async (extra) => {
		const { store } = fixture();
		await expect(
			new RegisterClientCommand(store).execute({ redirectUris: ["https://client.example/cb"], ...extra })
		).rejects.toMatchObject({ code: "invalid_client_metadata" });
		expect(store.insertClient).not.toHaveBeenCalled();
	});

	it("registration-accepts-refresh-grant", async () => {
		const { store } = fixture();
		const command = new RegisterClientCommand(store);
		// R19: the declared grants are a set — the standard client's set, its reversed order, and repetition.
		await command.execute({
			redirectUris: ["https://client.example/cb"],
			grantTypes: ["authorization_code", "refresh_token"]
		});
		await command.execute({
			redirectUris: ["https://client.example/cb"],
			grantTypes: ["refresh_token", "authorization_code"]
		});
		await command.execute({
			redirectUris: ["https://client.example/cb"],
			grantTypes: ["refresh_token", "authorization_code", "refresh_token"]
		});
		// The default is untouched: a client that declares nothing still registers.
		await command.execute({ redirectUris: ["https://client.example/cb"] });
		expect(store.insertClient).toHaveBeenCalledTimes(4);
	});

	it.each<{ grantTypes: string[] }>([
		{ grantTypes: [] },
		{ grantTypes: ["refresh_token"] },
		{ grantTypes: ["client_credentials"] },
		{ grantTypes: ["implicit"] },
		{ grantTypes: ["authorization_code", "client_credentials"] },
		{ grantTypes: ["authorization_code", "refresh_token", "client_credentials"] }
	])("rejects a declared grant set %j that is not the advertised set", async ({ grantTypes }) => {
		const { store } = fixture();
		await expect(
			new RegisterClientCommand(store).execute({ redirectUris: ["https://client.example/cb"], grantTypes })
		).rejects.toMatchObject({
			code: "invalid_client_metadata",
			message: "Public authorization-code client metadata is required."
		});
		// The declared set grants nothing and is never stored: a rejected registration writes no row.
		expect(store.insertClient).not.toHaveBeenCalled();
	});

	it("binds separate Discord state to the unchanged client state and requests identify only", async () => {
		const { store, begin, input } = fixture();
		const result = await begin.execute(input);
		const target = new URL(result.redirectUrl);
		expect(target.origin).toBe("https://discord.com");
		expect(target.searchParams.get("scope")).toBe("identify");
		expect(target.searchParams.get("state")).not.toBe(input.state);
		expect(store.insertPendingRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				clientState: input.state,
				discordState: target.searchParams.get("state"),
				codeChallenge: input.codeChallenge
			})
		);
	});

	it.each(["", "https://client.example/cb/extra", "https://other.example/cb", "https://client.example/"])(
		"rejects non-exact redirect %s without pending writes",
		async (redirectUri) => {
			const { store, begin, input } = fixture();
			await expect(begin.execute({ ...input, redirectUri })).rejects.toMatchObject({ code: "invalid_request" });
			expect(store.insertPendingRequest).not.toHaveBeenCalled();
		}
	);

	it.each([{ state: "" }, { codeChallenge: "" }, { codeChallengeMethod: "plain" }, { responseType: "token" }])(
		"rejects missing state and unsupported PKCE/grants",
		async (extra) => {
			const { store, begin, input } = fixture();
			await expect(begin.execute({ ...input, ...extra })).rejects.toMatchObject({ code: "invalid_request" });
			expect(store.insertPendingRequest).not.toHaveBeenCalled();
		}
	);

	it("registration echoes the grant set the client declared", async () => {
		const { store, begin } = fixture();
		const controller = new OAuthController(
			new GetAuthorizationServerMetadataQuery("https://hub.example"),
			new RegisterClientCommand(store),
			begin
		);
		const bodies: unknown[] = [];
		const response = {
			status(_code: number) {
				return this;
			},
			setHeader(_name: string, _value: string) {},
			json(value: unknown) {
				bodies.push(value);
			},
			redirect() {
				throw new Error("Unexpected redirect");
			}
		};
		// R19: the response reports what was registered, so a client that declared `refresh_token` is not told
		// its declaration was dropped — the false signal R17/R19 exist to remove.
		await controller.register(
			{ redirect_uris: ["https://client.example/cb"], grant_types: ["authorization_code", "refresh_token"] },
			response
		);
		await controller.register({ redirect_uris: ["https://client.example/cb"] }, response);
		expect(bodies[0]).toMatchObject({
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"]
		});
		expect(bodies[1]).toMatchObject({ grant_types: ["authorization_code"] });
	});

	it("renders safe local OAuth errors and never redirects an invalid authorize request", async () => {
		const { store, begin } = fixture();
		const controller = new OAuthController(
			new GetAuthorizationServerMetadataQuery("https://hub.example"),
			new RegisterClientCommand(store),
			begin
		);
		let status = 0;
		let body: unknown;
		const headers: Record<string, string> = {};
		const response = {
			status(code: number) {
				status = code;
				return this;
			},
			setHeader(name: string, value: string) {
				headers[name] = value;
			},
			json(value: unknown) {
				body = value;
			},
			redirect() {
				throw new Error("Unexpected redirect");
			}
		};
		await controller.authorize({ client_id: "client", redirect_uri: "https://evil.example" }, response);
		expect(status).toBe(400);
		expect(body).toMatchObject({ error: "invalid_request" });
		expect(headers["Location"]).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("evil.example");
	});
});
