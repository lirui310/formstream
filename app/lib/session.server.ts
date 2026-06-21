import { redirect } from "react-router";
import { createSupabaseServerClient } from "./supabase.server";

export interface SessionInfo {
	userId: string;
	email?: string;
	accessToken: string;
	role: "user" | "admin";
	status: "active" | "suspended";
	headers: Headers;
}

/**
 * Returns null if there's no logged-in session — does not redirect.
 *
 * Uses `getUser()` (verifies the token against the Auth server) rather than
 * `getSession()` to decide *who* the caller is — the cookie's decoded session
 * object alone isn't proof of authenticity. The access token string itself is
 * still read from the session, but it's meaningless without a valid signature,
 * which our own `/api/*` JWT/JWKS check (workers/lib/jwt.ts) verifies independently.
 */
export async function getOptionalSession(request: Request, env: Env): Promise<SessionInfo | null> {
	const { supabase, headers } = createSupabaseServerClient(request, env);

	const { data: userData, error: userError } = await supabase.auth.getUser();
	if (userError || !userData.user) return null;

	const { data: sessionData } = await supabase.auth.getSession();
	const accessToken = sessionData.session?.access_token;
	if (!accessToken) return null;

	const { data: profile } = await supabase
		.from("profiles")
		.select("role,status")
		.eq("id", userData.user.id)
		.maybeSingle();
	if (!profile) return null;

	return {
		userId: userData.user.id,
		email: userData.user.email,
		accessToken,
		role: profile.role,
		status: profile.status,
		headers,
	};
}

/** Throws a redirect to /login when there's no session — use in loaders/actions that require auth. */
export async function requireSession(request: Request, env: Env): Promise<SessionInfo> {
	const session = await getOptionalSession(request, env);
	if (!session) throw redirect("/login");
	if (session.status === "suspended") throw redirect("/login?suspended=1");
	return session;
}
