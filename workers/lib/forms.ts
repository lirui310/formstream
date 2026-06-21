import { createAdminClient } from "./supabase-admin";
import type { Form } from "./database.types";

const CACHE_TTL_SECONDS = 60;

function cacheKey(accessKey: string) {
	return `form:${accessKey}`;
}

/** KV-cached lookup so hot forms don't hit Postgres on every submission. */
export async function getFormByAccessKey(env: Env, accessKey: string): Promise<Form | null> {
	const cached = await env.RATE_LIMIT.get(cacheKey(accessKey));
	if (cached) return JSON.parse(cached) as Form;

	const admin = createAdminClient(env);
	const { data: form } = await admin
		.from("forms")
		.select("*")
		.eq("access_key", accessKey)
		.maybeSingle();

	if (!form) return null;
	await env.RATE_LIMIT.put(cacheKey(accessKey), JSON.stringify(form), {
		expirationTtl: CACHE_TTL_SECONDS,
	});
	return form;
}

export async function invalidateFormCache(env: Env, accessKey: string) {
	await env.RATE_LIMIT.delete(cacheKey(accessKey));
}
