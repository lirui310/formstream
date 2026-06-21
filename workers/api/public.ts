import { Hono } from "hono";
import { createAdminClient } from "../lib/supabase-admin";
import { checkRateLimit } from "../lib/rate-limit";
import { getFormByAccessKey } from "../lib/forms";
import { checkAndBumpUsage } from "../lib/usage";
import { verifyTurnstile } from "../lib/turnstile";
import { sanitizeRedirectPath } from "../lib/redirect";
import { PLAN_FILE_LIMITS, PLAN_SUBMISSION_LIMITS } from "../lib/plan-limits";
import type { NotifyMessage } from "../lib/notify-types";
import { deleteUploadKeys } from "../lib/upload-cleanup";

const RESERVED_FIELDS = new Set(["_redirect", "_subject", "_honey", "cf-turnstile-response"]);

export const publicApp = new Hono<{ Bindings: Env }>();

// Public endpoint is called cross-origin from arbitrary static sites; reflect Origin
// on the preflight and let the handler do the real allowed_domains enforcement.
publicApp.use("*", async (c, next) => {
	const origin = c.req.header("Origin");
	if (origin) c.header("Access-Control-Allow-Origin", origin);
	c.header("Vary", "Origin");
	c.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
	c.header("Access-Control-Allow-Headers", "Content-Type");
	await next();
});
publicApp.options("*", (c) => c.body(null, 204));

function hostFromHeader(value: string | undefined): string | null {
	if (!value) return null;
	try {
		return new URL(value).host;
	} catch {
		return null;
	}
}

publicApp.get("/thanks", (c) =>
	c.html("<!doctype html><html><body><p>Thanks — your submission was received.</p></body></html>"),
);

publicApp.post("/:accessKey", async (c) => {
	const accessKey = c.req.param("accessKey");
	const form = await getFormByAccessKey(c.env, accessKey);
	if (!form || !form.is_active) {
		return c.json({ success: false, code: "NOT_FOUND", message: "form not found or inactive" }, 404);
	}

	if (form.allowed_domains.length > 0) {
		const host = hostFromHeader(c.req.header("Origin")) ?? hostFromHeader(c.req.header("Referer"));
		if (!host || !form.allowed_domains.includes(host)) {
			return c.json({ success: false, code: "FORBIDDEN", message: "domain not allowed" }, 403);
		}
	}

	const ip = c.req.header("CF-Connecting-IP") ?? "0.0.0.0";
	// Dual dimension (docs §6.3): per form+IP catches one abusive visitor, per form
	// alone catches the same form being hammered from rotating/many IPs.
	const withinIpLimit = await checkRateLimit(c.env.RATE_LIMIT, `rl:${accessKey}:${ip}`, 20, 60);
	if (!withinIpLimit) {
		return c.json({ success: false, code: "RATE_LIMITED", message: "too many submissions" }, 429);
	}
	const withinFormLimit = await checkRateLimit(c.env.RATE_LIMIT, `rl:${accessKey}`, 120, 60);
	if (!withinFormLimit) {
		return c.json({ success: false, code: "RATE_LIMITED", message: "form is receiving too many submissions" }, 429);
	}

	const contentType = c.req.header("Content-Type") ?? "";
	const fields: Record<string, string> = {};
	const fileEntries: Array<[string, File]> = [];

	if (contentType.includes("application/json")) {
		const json = await c.req.json().catch(() => ({}) as Record<string, unknown>);
		for (const [k, v] of Object.entries(json)) fields[k] = String(v);
	} else {
		const formData = await c.req.formData();
		for (const [key, value] of formData.entries()) {
			if (value instanceof File) {
				fileEntries.push([key, value]);
			} else {
				fields[key] = value;
			}
		}
	}

	if (form.turnstile_enabled) {
		if (!c.env.TURNSTILE_SECRET) {
			console.error(JSON.stringify({ message: "Turnstile is enabled without TURNSTILE_SECRET", formId: form.id }));
			return c.json(
				{ success: false, code: "TURNSTILE_UNAVAILABLE", message: "human verification is unavailable" },
				503,
			);
		}

		let verified: boolean;
		try {
			verified = await verifyTurnstile(fields["cf-turnstile-response"] ?? "", c.env.TURNSTILE_SECRET, ip);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "Turnstile verification request failed",
					formId: form.id,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			return c.json(
				{ success: false, code: "TURNSTILE_UNAVAILABLE", message: "human verification is unavailable" },
				503,
			);
		}
		if (!verified) {
			return c.json({ success: false, code: "FORBIDDEN", message: "turnstile verification failed" }, 403);
		}
	}

	const isSpam = Boolean(fields["_honey"]);
	const redirectOverride = sanitizeRedirectPath(fields["_redirect"]);
	const subject = fields["_subject"] || null;

	const data: Record<string, string> = {};
	for (const [k, v] of Object.entries(fields)) {
		if (RESERVED_FIELDS.has(k)) continue;
		data[k] = v;
	}

	const admin = createAdminClient(c.env);
	const { data: ownerProfile } = await admin
		.from("profiles")
		.select("plan")
		.eq("id", form.user_id)
		.maybeSingle();
	const plan = ownerProfile?.plan ?? "free";

	// Spam never gets stored or uploaded — only legitimate submissions should consume
	// R2/storage quota, otherwise a honeypot-tripping bot can run up unlimited storage.
	const filesToUpload = isSpam ? [] : fileEntries;

	if (filesToUpload.length > 0) {
		const sizeLimit = PLAN_FILE_LIMITS[plan];
		if (sizeLimit === null) {
			return c.json(
				{ success: false, code: "PLAN_LIMIT", message: "file uploads require a paid plan" },
				403,
			);
		}
		for (const [, file] of filesToUpload) {
			if (file.size > sizeLimit) {
				return c.json(
					{
						success: false,
						code: "PLAN_LIMIT",
						message: `file too large, max ${Math.floor(sizeLimit / 1024 / 1024)}MB on your plan`,
					},
					413,
				);
			}
		}
	}

	if (!isSpam) {
		const { allowed } = await checkAndBumpUsage(admin, form.user_id, PLAN_SUBMISSION_LIMITS[plan]);
		if (!allowed) {
			return c.json(
				{ success: false, code: "QUOTA_EXCEEDED", message: "monthly submission quota exceeded" },
				403,
			);
		}
	}

	const submissionId = crypto.randomUUID();
	const files: Array<{ name: string; key: string; size: number; type: string }> = [];
	try {
		for (const [, file] of filesToUpload) {
			const r2Key = `${form.id}/${submissionId}/${file.name}`;
			await c.env.UPLOADS.put(r2Key, file.stream(), {
				httpMetadata: { contentType: file.type || "application/octet-stream" },
			});
			files.push({ name: file.name, key: r2Key, size: file.size, type: file.type });
		}
	} catch (error) {
		await deleteUploadKeys(
			c.env.UPLOADS,
			files.map((file) => file.key),
		).catch((cleanupError) => {
			console.error(
				JSON.stringify({
					message: "failed to clean up partial uploads",
					submissionId,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				}),
			);
		});
		console.error(
			JSON.stringify({
				message: "submission upload failed",
				submissionId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return c.json({ success: false, code: "UPLOAD_ERROR", message: "file upload failed" }, 500);
	}

	const { error: submissionError } = await admin.from("submissions").insert({
		id: submissionId,
		form_id: form.id,
		data,
		files,
		ip,
		user_agent: c.req.header("User-Agent") ?? null,
		country: c.req.header("CF-IPCountry") ?? null,
		is_spam: isSpam,
	});
	if (submissionError) {
		await deleteUploadKeys(
			c.env.UPLOADS,
			files.map((file) => file.key),
		).catch((cleanupError) => {
			console.error(
				JSON.stringify({
					message: "failed to clean up uploads after database error",
					submissionId,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				}),
			);
		});
		console.error(
			JSON.stringify({ message: "submission insert failed", submissionId, error: submissionError.message }),
		);
		return c.json({ success: false, code: "DB_ERROR", message: "failed to save submission" }, 500);
	}

	if (!isSpam) {
		const message: NotifyMessage = { submissionId, formId: form.id, subject };
		await c.env.NOTIFY_QUEUE.send(message);
	}

	const wantsJson = (c.req.header("Accept") ?? "").includes("application/json");
	if (wantsJson) {
		return c.json({ success: true, id: submissionId });
	}
	return c.redirect(redirectOverride ?? sanitizeRedirectPath(form.redirect_url) ?? "/s/thanks", 302);
});
