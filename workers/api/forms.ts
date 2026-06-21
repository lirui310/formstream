import { Hono } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createUserClient } from "../lib/supabase-admin";
import { requireUser, type AppEnv } from "../lib/auth-middleware";
import { invalidateFormCache } from "../lib/forms";
import { dispatchChannel } from "../lib/notify-channels";
import { sanitizeRedirectPath } from "../lib/redirect";
import { PLAN_CHANNEL_LIMITS, PLAN_FORM_LIMITS } from "../lib/plan-limits";
import { submissionsToCsv } from "../lib/csv";
import { deleteFormUploads, deleteSubmissionUploads } from "../lib/upload-cleanup";
import type { ChannelType, Database, Form, Plan } from "../lib/database.types";

export const formsApp = new Hono<AppEnv>();
formsApp.use("*", requireUser);

function fail(c: import("hono").Context, code: string, message: string, status: 400 | 403 | 404 | 500 | 503 = 400) {
	return c.json({ success: false, code, message }, status);
}

async function getUserPlan(supabase: SupabaseClient<Database>, userId: string): Promise<Plan> {
	const { data } = await supabase.from("profiles").select("plan").eq("id", userId).maybeSingle();
	return data?.plan ?? "free";
}

formsApp.post("/forms", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) return fail(c, "BAD_REQUEST", "name is required");

	const allowedDomains = Array.isArray(body.allowed_domains)
		? body.allowed_domains.filter((d: unknown): d is string => typeof d === "string")
		: [];

	const supabase = createUserClient(c.env, auth.jwt);

	const plan = await getUserPlan(supabase, auth.userId);
	const formLimit = PLAN_FORM_LIMITS[plan];
	if (formLimit !== null) {
		const { count } = await supabase.from("forms").select("*", { count: "exact", head: true });
		if ((count ?? 0) >= formLimit) {
			return fail(c, "QUOTA_EXCEEDED", `表单数已达 ${plan} 套餐上限(${formLimit})，请升级套餐`, 403);
		}
	}

	const { data, error } = await supabase
		.from("forms")
		.insert({ user_id: auth.userId, name, allowed_domains: allowedDomains })
		.select()
		.single();

	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data });
});

formsApp.get("/forms", async (c) => {
	const auth = c.get("auth");
	const supabase = createUserClient(c.env, auth.jwt);
	const { data, error } = await supabase.from("forms").select("*").order("created_at", { ascending: false });
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data });
});

formsApp.get("/forms/:id", async (c) => {
	const auth = c.get("auth");
	const supabase = createUserClient(c.env, auth.jwt);
	const { data, error } = await supabase.from("forms").select("*").eq("id", c.req.param("id")).maybeSingle();
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	if (!data) return fail(c, "NOT_FOUND", "form not found", 404);
	return c.json({ success: true, data });
});

formsApp.patch("/forms/:id", async (c) => {
	const auth = c.get("auth");
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);

	const patch: Partial<Form> = {};
	if (typeof body.name === "string") patch.name = body.name.trim();
	if (Array.isArray(body.allowed_domains)) {
		patch.allowed_domains = body.allowed_domains.filter((d: unknown): d is string => typeof d === "string");
	}
	if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
	if (typeof body.turnstile_enabled === "boolean") {
		if (body.turnstile_enabled && !c.env.TURNSTILE_SECRET) {
			return fail(c, "TURNSTILE_UNAVAILABLE", "TURNSTILE_SECRET is not configured", 503);
		}
		patch.turnstile_enabled = body.turnstile_enabled;
	}
	if (typeof body.redirect_url === "string") {
		const safePath = sanitizeRedirectPath(body.redirect_url);
		if (!safePath) return fail(c, "BAD_REQUEST", "redirect_url must be a relative path (e.g. /thanks)");
		patch.redirect_url = safePath;
	} else if (body.redirect_url === null) {
		patch.redirect_url = null;
	}
	if (typeof body.spam_protection === "boolean") patch.spam_protection = body.spam_protection;
	patch.updated_at = new Date().toISOString();

	const supabase = createUserClient(c.env, auth.jwt);
	const { data: existing } = await supabase.from("forms").select("access_key").eq("id", id).maybeSingle();
	const { data, error } = await supabase.from("forms").update(patch).eq("id", id).select().maybeSingle();
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	if (!data) return fail(c, "NOT_FOUND", "form not found", 404);
	if (existing) await invalidateFormCache(c.env, existing.access_key);
	return c.json({ success: true, data });
});

formsApp.delete("/forms/:id", async (c) => {
	const auth = c.get("auth");
	const id = c.req.param("id");
	const supabase = createUserClient(c.env, auth.jwt);
	const { data: existing, error: existingError } = await supabase
		.from("forms")
		.select("access_key")
		.eq("id", id)
		.maybeSingle();
	if (existingError) return fail(c, "DB_ERROR", existingError.message, 500);
	if (!existing) return fail(c, "NOT_FOUND", "form not found", 404);

	try {
		await deleteFormUploads(c.env.UPLOADS, supabase, id);
	} catch (error) {
		return fail(c, "STORAGE_ERROR", error instanceof Error ? error.message : "failed to delete uploads", 500);
	}
	const { error } = await supabase.from("forms").delete().eq("id", id);
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	await invalidateFormCache(c.env, existing.access_key);
	return c.json({ success: true });
});

formsApp.get("/forms/:id/submissions", async (c) => {
	const auth = c.get("auth");
	const id = c.req.param("id");
	const page = Math.max(1, Number(c.req.query("page") ?? "1"));
	const size = Math.min(100, Math.max(1, Number(c.req.query("size") ?? "20")));
	const from = (page - 1) * size;
	const to = from + size - 1;

	const supabase = createUserClient(c.env, auth.jwt);
	const { data, error, count } = await supabase
		.from("submissions")
		.select("*", { count: "exact" })
		.eq("form_id", id)
		.order("created_at", { ascending: false })
		.range(from, to);

	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data, page, size, total: count ?? 0 });
});

formsApp.get("/forms/:id/submissions/export", async (c) => {
	const auth = c.get("auth");
	const id = c.req.param("id");
	const supabase = createUserClient(c.env, auth.jwt);
	const { data, error } = await supabase
		.from("submissions")
		.select("*")
		.eq("form_id", id)
		.order("created_at", { ascending: false })
		.range(0, 4999);

	if (error) return fail(c, "DB_ERROR", error.message, 500);

	const csv = submissionsToCsv(data ?? []);
	return new Response(csv, {
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="submissions-${id}.csv"`,
		},
	});
});

formsApp.delete("/submissions/:id", async (c) => {
	const auth = c.get("auth");
	const supabase = createUserClient(c.env, auth.jwt);
	const id = c.req.param("id");
	try {
		const found = await deleteSubmissionUploads(c.env.UPLOADS, supabase, id);
		if (!found) return fail(c, "NOT_FOUND", "submission not found", 404);
	} catch (error) {
		return fail(c, "STORAGE_ERROR", error instanceof Error ? error.message : "failed to delete uploads", 500);
	}

	const { error } = await supabase.from("submissions").delete().eq("id", id);
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true });
});

formsApp.post("/forms/:id/channels", async (c) => {
	const auth = c.get("auth");
	const formId = c.req.param("id");
	const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
	const validTypes: ChannelType[] = ["dingtalk", "feishu", "wework", "email", "webhook"];
	const type = body.type;
	if (typeof type !== "string" || !(validTypes as string[]).includes(type)) {
		return fail(c, "BAD_REQUEST", "invalid channel type");
	}
	const channelType = type as ChannelType;
	if (typeof body.config !== "object" || body.config === null) {
		return fail(c, "BAD_REQUEST", "config is required");
	}

	const supabase = createUserClient(c.env, auth.jwt);

	const plan = await getUserPlan(supabase, auth.userId);
	const channelLimit = PLAN_CHANNEL_LIMITS[plan];
	if (channelLimit !== null) {
		const { count } = await supabase
			.from("notification_channels")
			.select("*", { count: "exact", head: true })
			.eq("form_id", formId);
		if ((count ?? 0) >= channelLimit) {
			return fail(c, "QUOTA_EXCEEDED", `该表单通知渠道数已达 ${plan} 套餐上限(${channelLimit})，请升级套餐`, 403);
		}
	}

	const { data, error } = await supabase
		.from("notification_channels")
		.insert({ form_id: formId, type: channelType, config: body.config })
		.select()
		.single();

	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data });
});

formsApp.get("/forms/:id/channels", async (c) => {
	const auth = c.get("auth");
	const supabase = createUserClient(c.env, auth.jwt);
	const { data, error } = await supabase
		.from("notification_channels")
		.select("*")
		.eq("form_id", c.req.param("id"));
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data });
});

formsApp.delete("/channels/:id", async (c) => {
	const auth = c.get("auth");
	const supabase = createUserClient(c.env, auth.jwt);
	const { error } = await supabase.from("notification_channels").delete().eq("id", c.req.param("id"));
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true });
});

formsApp.post("/channels/:id/test", async (c) => {
	const auth = c.get("auth");
	const supabase = createUserClient(c.env, auth.jwt);

	const { data: channel, error: channelError } = await supabase
		.from("notification_channels")
		.select("*")
		.eq("id", c.req.param("id"))
		.maybeSingle();
	if (channelError) return fail(c, "DB_ERROR", channelError.message, 500);
	if (!channel) return fail(c, "NOT_FOUND", "channel not found", 404);

	const { data: form } = await supabase.from("forms").select("*").eq("id", channel.form_id).maybeSingle();
	if (!form) return fail(c, "NOT_FOUND", "form not found", 404);

	const testSubmission = {
		id: "test",
		form_id: form.id,
		data: { message: "这是一条来自 FormStream 的测试通知" },
		files: [],
		ip: null,
		user_agent: null,
		country: null,
		is_spam: false,
		created_at: new Date().toISOString(),
	};

	const result = await dispatchChannel(c.env, channel, form, testSubmission, "FormStream 渠道测试");
	if (!result.ok) {
		return c.json({ success: false, code: "CHANNEL_TEST_FAILED", message: result.error ?? "delivery failed" }, 400);
	}
	return c.json({ success: true });
});

formsApp.get("/me", async (c) => {
	const auth = c.get("auth");
	const supabase = createUserClient(c.env, auth.jwt);
	const { data, error } = await supabase.from("profiles").select("*").eq("id", auth.userId).maybeSingle();
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data });
});

formsApp.get("/me/usage", async (c) => {
	const auth = c.get("auth");
	const supabase = createUserClient(c.env, auth.jwt);
	const { data, error } = await supabase
		.from("usage")
		.select("*")
		.eq("user_id", auth.userId)
		.order("period", { ascending: false });
	if (error) return fail(c, "DB_ERROR", error.message, 500);
	return c.json({ success: true, data });
});
