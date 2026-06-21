import apiApp from "../../workers/api";

/**
 * Dashboard loaders/actions go through the same /api/* Hono routes a programmatic
 * API consumer would use (per docs §4.2), just invoked in-process instead of over
 * the network — no extra round trip, same code path, same RLS enforcement.
 */
export async function callApi(
	requestUrl: string,
	env: Env,
	ctx: ExecutionContext,
	path: string,
	accessToken: string,
	init?: RequestInit,
): Promise<Response> {
	const url = new URL(path, requestUrl);
	const headers = new Headers(init?.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	const req = new Request(url, { ...init, headers });
	return apiApp.fetch(req, env, ctx);
}

export async function callApiJson<T = unknown>(
	requestUrl: string,
	env: Env,
	ctx: ExecutionContext,
	path: string,
	accessToken: string,
	init?: RequestInit,
): Promise<{ status: number; body: T }> {
	const res = await callApi(requestUrl, env, ctx, path, accessToken, init);
	const body = (await res.json()) as T;
	return { status: res.status, body };
}
