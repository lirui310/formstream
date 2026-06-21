import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/** Service-role client: bypasses RLS. Only for the public submit endpoint and admin domain. */
export function createAdminClient(env: Env) {
	return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
}

/** Anon-key client scoped to a user's JWT: Postgrest enforces RLS as that user. */
export function createUserClient(env: Env, jwt: string) {
	return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
		auth: { autoRefreshToken: false, persistSession: false },
		global: { headers: { Authorization: `Bearer ${jwt}` } },
	});
}
