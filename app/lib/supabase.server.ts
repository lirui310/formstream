import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../workers/lib/database.types";

/**
 * Per-request SSR client backed by the session cookie. `headers` accumulates any
 * Set-Cookie the auth library needs to issue (refreshed/cleared session) — callers
 * must merge it into whatever Response/redirect they return.
 */
export function createSupabaseServerClient(
	request: Request,
	env: Env,
): { supabase: SupabaseClient<Database>; headers: Headers } {
	const headers = new Headers();
	const supabase = createServerClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
		cookies: {
			getAll() {
				return parseCookieHeader(request.headers.get("Cookie") ?? "").map((c) => ({
					name: c.name,
					value: c.value ?? "",
				}));
			},
			setAll(cookiesToSet) {
				for (const { name, value, options } of cookiesToSet) {
					headers.append("Set-Cookie", serializeCookieHeader(name, value, options));
				}
			},
		},
	});
	return { supabase, headers };
}
