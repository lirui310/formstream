import { createRemoteJWKSet, jwtVerify } from "jose";

// jose caches the underlying JWKS fetch (with its own TTL) inside the returned
// function, so keep one instance per isolate instead of refetching per request.
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedForUrl: string | undefined;

function getJwks(env: Env) {
	const jwksUrl = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
	if (!cachedJwks || cachedForUrl !== jwksUrl) {
		cachedJwks = createRemoteJWKSet(new URL(jwksUrl));
		cachedForUrl = jwksUrl;
	}
	return cachedJwks;
}

export interface AuthUser {
	id: string;
	email?: string;
}

/** Verifies a Supabase Auth access token's signature against the project's JWKS. */
export async function verifyUserJwt(token: string, env: Env): Promise<AuthUser> {
	const { payload } = await jwtVerify(token, getJwks(env), {
		issuer: `${env.SUPABASE_URL}/auth/v1`,
	});
	if (!payload.sub) throw new Error("JWT missing sub claim");
	return {
		id: payload.sub,
		email: typeof payload.email === "string" ? payload.email : undefined,
	};
}
