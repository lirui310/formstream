import type { Context, Next } from "hono";
import { verifyUserJwt } from "./jwt";
import { createAdminClient } from "./supabase-admin";
import type { Role, ProfileStatus } from "./database.types";

export interface AuthContext {
	userId: string;
	email?: string;
	jwt: string;
	role: Role;
	status: ProfileStatus;
}

export type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } };

function unauthorized(c: Context, message: string) {
	return c.json({ success: false, code: "UNAUTHORIZED", message }, 401);
}

function forbidden(c: Context, message: string) {
	return c.json({ success: false, code: "FORBIDDEN", message }, 403);
}

/** Verifies the bearer JWT, loads profile role/status, rejects suspended accounts. */
export async function requireUser(c: Context<AppEnv>, next: Next) {
	const authHeader = c.req.header("Authorization");
	const token = authHeader?.match(/^Bearer (.+)$/)?.[1];
	if (!token) return unauthorized(c, "missing bearer token");

	let user: { id: string; email?: string };
	try {
		user = await verifyUserJwt(token, c.env);
	} catch {
		return unauthorized(c, "invalid or expired token");
	}

	const admin = createAdminClient(c.env);
	const { data: profile } = await admin
		.from("profiles")
		.select("role,status")
		.eq("id", user.id)
		.maybeSingle();

	if (!profile) return unauthorized(c, "profile not found");
	if (profile.status === "suspended") return forbidden(c, "account suspended");

	c.set("auth", {
		userId: user.id,
		email: user.email,
		jwt: token,
		role: profile.role,
		status: profile.status,
	});
	await next();
}

/** Chain after requireUser. */
export async function requireAdmin(c: Context<AppEnv>, next: Next) {
	const auth = c.get("auth");
	if (!auth || auth.role !== "admin") return forbidden(c, "admin only");
	await next();
}
