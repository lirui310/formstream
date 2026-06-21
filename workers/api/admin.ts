import { Hono } from "hono";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createAdminClient } from "../lib/supabase-admin";
import { requireAdmin, requireUser, type AppEnv } from "../lib/auth-middleware";
import { invalidateFormCache } from "../lib/forms";
import { logAudit } from "../lib/audit";
import { deleteUserUploads } from "../lib/upload-cleanup";
import type { Database, Profile } from "../lib/database.types";

export const adminApp = new Hono<AppEnv>();
adminApp.use("*", requireUser, requireAdmin);

function fail(c: import("hono").Context, code: string, message: string, status: 400 | 403 | 404 | 500 = 400) {
	return c.json({ success: false, code, message }, status);
}

async function mergeWithProfiles(admin: SupabaseClient<Database>, users: User[]) {
	const { data: profiles } = await admin
		.from("profiles")
		.select("*")
		.in("id", users.map((u) => u.id));
	const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));

	return users.map((u) => ({
		id: u.id,
		email: u.email,
		created_at: u.created_at,
		role: profileMap.get(u.id)?.role ?? "user",
		status: profileMap.get(u.id)?.status ?? "active",
		plan: profileMap.get(u.id)?.plan ?? "free",
	}));
}

adminApp.get("/users", async (c) => {
	const q = (c.req.query("q") ?? "").trim().toLowerCase();
	const page = Math.max(1, Number(c.req.query("page") ?? "1"));
	const size = Math.min(100, Math.max(1, Number(c.req.query("size") ?? "20")));

	const admin = createAdminClient(c.env);

	if (!q) {
		// No search: ask the Auth API for exactly the requested page — was previously
		// always pulling the first 1000 users regardless of `page`, silently hiding
		// anyone past user #1000 from pagination/search once the platform grew past it.
		const { data: usersPage, error } = await admin.auth.admin.listUsers({ page, perPage: size });
		if (error) return fail(c, "DB_ERROR", error.message, 500);
		const merged = await mergeWithProfiles(admin, usersPage.users);
		return c.json({ success: true, data: merged, page, size, total: usersPage.total });
	}

	// Search: the Auth admin API has no server-side filter, so scan pages ourselves and
	// collect matches, capped at 10k users — still a documented MVP-scale limit, but now
	// it actually scans everyone up to that cap instead of silently only the first 1000.
	const PAGE_SIZE = 1000;
	const MAX_PAGES = 10;
	const matches: User[] = [];
	for (let p = 1; p <= MAX_PAGES; p++) {
		const { data: usersPage, error } = await admin.auth.admin.listUsers({ page: p, perPage: PAGE_SIZE });
		if (error) return fail(c, "DB_ERROR", error.message, 500);
		matches.push(...usersPage.users.filter((u) => u.email?.toLowerCase().includes(q)));
		if (usersPage.users.length < PAGE_SIZE) break;
	}

	const total = matches.length;
	const from = (page - 1) * size;
	const merged = await mergeWithProfiles(admin, matches.slice(from, from + size));
	return c.json({ success: true, data: merged, page, size, total });
});

adminApp.get("/users/:id", async (c) => {
	const admin = createAdminClient(c.env);
	const userId = c.req.param("id");
	const { data: authUser, error } = await admin.auth.admin.getUserById(userId);
	if (error || !authUser.user) return fail(c, "NOT_FOUND", "user not found", 404);

	const [{ data: profile }, { count: formCount }, { data: usage }] = await Promise.all([
		admin.from("profiles").select("*").eq("id", userId).maybeSingle(),
		admin.from("forms").select("*", { count: "exact", head: true }).eq("user_id", userId),
		admin.from("usage").select("*").eq("user_id", userId).order("period", { ascending: false }).limit(12),
	]);

	return c.json({
		success: true,
		data: {
			id: authUser.user.id,
			email: authUser.user.email,
			created_at: authUser.user.created_at,
			role: profile?.role ?? "user",
			status: profile?.status ?? "active",
			plan: profile?.plan ?? "free",
			form_count: formCount ?? 0,
			usage: usage ?? [],
		},
	});
});

adminApp.patch("/users/:id", async (c) => {
	const userId = c.req.param("id");
	const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);

	const patch: Partial<Profile> = {};
	if (typeof body.plan === "string" && ["free", "pro", "business"].includes(body.plan)) patch.plan = body.plan;
	if (typeof body.status === "string" && ["active", "suspended"].includes(body.status)) patch.status = body.status;
	if (typeof body.role === "string" && ["user", "admin"].includes(body.role)) patch.role = body.role;
	if (Object.keys(patch).length === 0) return fail(c, "BAD_REQUEST", "nothing to update");

	const admin = createAdminClient(c.env);
	const { data, error } = await admin.from("profiles").update(patch).eq("id", userId).select().maybeSingle();
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	if (!data) return fail(c, "NOT_FOUND", "profile not found", 404);

	const auth = c.get("auth");
	await logAudit(admin, {
		actorId: auth.userId,
		actorEmail: auth.email,
		action: "user.update",
		targetType: "user",
		targetId: userId,
		detail: patch,
	});

	return c.json({ success: true, data });
});

adminApp.delete("/users/:id", async (c) => {
	const userId = c.req.param("id");
	const admin = createAdminClient(c.env);
	try {
		await deleteUserUploads(c.env.UPLOADS, admin, userId);
	} catch (error) {
		return fail(c, "STORAGE_ERROR", error instanceof Error ? error.message : "failed to delete uploads", 500);
	}
	const { error } = await admin.auth.admin.deleteUser(userId);
	if (error) return fail(c, "DB_ERROR", error.message, 500);

	const auth = c.get("auth");
	await logAudit(admin, {
		actorId: auth.userId,
		actorEmail: auth.email,
		action: "user.delete",
		targetType: "user",
		targetId: userId,
	});

	return c.json({ success: true });
});

adminApp.get("/forms", async (c) => {
	const admin = createAdminClient(c.env);
	const q = (c.req.query("q") ?? "").trim();

	if (!q) {
		const { data, error } = await admin.from("forms").select("*").order("created_at", { ascending: false }).limit(100);
		if (error) return fail(c, "DB_ERROR", error.message, 500);
		return c.json({ success: true, data });
	}

	// Two separate ilike queries + merge instead of a single .or() filter string,
	// so a user-controlled `q` can't break PostgREST filter syntax.
	const [byName, byKey] = await Promise.all([
		admin.from("forms").select("*").ilike("name", `%${q}%`).limit(50),
		admin.from("forms").select("*").ilike("access_key", `%${q}%`).limit(50),
	]);
	if (byName.error) return fail(c, "DB_ERROR", byName.error.message, 500);
	if (byKey.error) return fail(c, "DB_ERROR", byKey.error.message, 500);

	const merged = new Map([...(byName.data ?? []), ...(byKey.data ?? [])].map((f) => [f.id, f]));
	return c.json({ success: true, data: [...merged.values()] });
});

adminApp.patch("/forms/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
	if (typeof body.is_active !== "boolean") return fail(c, "BAD_REQUEST", "is_active boolean required");

	const admin = createAdminClient(c.env);
	const { data: existing } = await admin.from("forms").select("access_key").eq("id", id).maybeSingle();
	const { data, error } = await admin.from("forms").update({ is_active: body.is_active }).eq("id", id).select().maybeSingle();
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	if (!data) return fail(c, "NOT_FOUND", "form not found", 404);
	if (existing) await invalidateFormCache(c.env, existing.access_key);

	const auth = c.get("auth");
	await logAudit(admin, {
		actorId: auth.userId,
		actorEmail: auth.email,
		action: body.is_active ? "form.enable" : "form.force_disable",
		targetType: "form",
		targetId: id,
	});

	return c.json({ success: true, data });
});

adminApp.get("/logs", async (c) => {
	const page = Math.max(1, Number(c.req.query("page") ?? "1"));
	const size = Math.min(100, Math.max(1, Number(c.req.query("size") ?? "30")));
	const from = (page - 1) * size;
	const to = from + size - 1;

	const admin = createAdminClient(c.env);
	const { data, error, count } = await admin
		.from("audit_logs")
		.select("*", { count: "exact" })
		.order("created_at", { ascending: false })
		.range(from, to);
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data, page, size, total: count ?? 0 });
});

adminApp.get("/stats", async (c) => {
	const admin = createAdminClient(c.env);
	const [{ count: userCount }, { count: formCount }, { count: submissionCount }, { count: spamCount }] =
		await Promise.all([
			admin.from("profiles").select("*", { count: "exact", head: true }),
			admin.from("forms").select("*", { count: "exact", head: true }),
			admin.from("submissions").select("*", { count: "exact", head: true }),
			admin.from("submissions").select("*", { count: "exact", head: true }).eq("is_spam", true),
		]);

	// No group-by in PostgREST without an RPC/view, so pull a capped recent window
	// and aggregate in JS — fine at MVP submission volumes.
	const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
	const { data: recentSubmissions } = await admin
		.from("submissions")
		.select("created_at,is_spam,form_id")
		.gte("created_at", fourteenDaysAgo)
		.limit(5000);

	const trendByDay = new Map<string, number>();
	const countByForm = new Map<string, number>();
	for (const s of recentSubmissions ?? []) {
		const day = s.created_at.slice(0, 10);
		trendByDay.set(day, (trendByDay.get(day) ?? 0) + 1);
		if (!s.is_spam) countByForm.set(s.form_id, (countByForm.get(s.form_id) ?? 0) + 1);
	}
	const trend = [...trendByDay.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, count]) => ({ date, count }));

	const topFormIds = [...countByForm.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([id]) => id);
	const { data: topFormRows } =
		topFormIds.length > 0 ? await admin.from("forms").select("id,name").in("id", topFormIds) : { data: [] };
	const formNameById = new Map((topFormRows ?? []).map((f) => [f.id, f.name]));
	const topForms = topFormIds.map((id) => ({
		form_id: id,
		name: formNameById.get(id) ?? "(已删除)",
		count: countByForm.get(id) ?? 0,
	}));

	return c.json({
		success: true,
		data: {
			user_count: userCount ?? 0,
			form_count: formCount ?? 0,
			submission_count: submissionCount ?? 0,
			spam_count: spamCount ?? 0,
			spam_rate: submissionCount ? (spamCount ?? 0) / submissionCount : 0,
			trend,
			top_forms: topForms,
		},
	});
});

adminApp.get("/usage", async (c) => {
	const admin = createAdminClient(c.env);
	const { data, error } = await admin.from("usage").select("*").order("period", { ascending: false }).limit(500);
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data });
});
