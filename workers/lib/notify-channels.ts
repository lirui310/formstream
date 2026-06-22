import type { Form, NotificationChannel, Submission } from "./database.types";
import { renderSubmissionEmail } from "./email-template";
import { sendEmailNotification } from "./notify-email";

export interface DispatchResult {
	ok: boolean;
	status?: number;
	/** Worth retrying via the queue (429/5xx/network) vs a permanent config error. */
	retryable: boolean;
	error?: string;
}

function buildPlainTextSummary(form: Form, submission: Submission): string {
	const lines = Object.entries(submission.data).map(([k, v]) => `${k}: ${v}`);
	return `新提交 - ${form.name}\n${lines.join("\n")}\n时间: ${submission.created_at}`;
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Plain HTTP-status interpretation — for the generic user webhook, where we don't
 * know the response body schema, so a 2xx is the best success signal we have. */
async function interpretHttpResponse(res: Response): Promise<DispatchResult> {
	if (res.ok) return { ok: true, status: res.status, retryable: false };
	const retryable = res.status === 429 || res.status >= 500;
	return { ok: false, status: res.status, retryable, error: await res.text().catch(() => res.statusText) };
}

/** Reads a status code that platforms encode as either a JSON number or a numeric
 * string (Dingtalk's docs show `errcode` as the string `"0"` in places). */
function toStatusCode(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/**
 * Dingtalk / Feishu / WeCom all return **HTTP 200 even when the message is rejected**
 * (bad sign, rate limit, expired token, keyword filter); the real outcome is a status
 * code in the JSON body where 0 = success. Checking only `res.ok` would report a
 * rejected message as "delivered", so we must parse the body's status code.
 *
 * `successFields` lists the body field(s) that carry that code (dingtalk/wecom use
 * `errcode`, feishu uses `code` on new bots and `StatusCode` on old ones).
 * `retryableCodes` are the non-zero codes worth retrying via the queue (rate limits
 * plus transient "system busy" errors); every other non-zero code is treated as a
 * permanent config error that retrying won't fix.
 */
async function interpretImResponse(
	res: Response,
	successFields: string[],
	retryableCodes: number[],
): Promise<DispatchResult> {
	if (!res.ok) {
		const retryable = res.status === 429 || res.status >= 500;
		return { ok: false, status: res.status, retryable, error: await res.text().catch(() => res.statusText) };
	}

	let body: Record<string, unknown>;
	try {
		body = (await res.json()) as Record<string, unknown>;
	} catch {
		return { ok: false, status: res.status, retryable: false, error: "IM platform returned a non-JSON response" };
	}

	const code = successFields.map((f) => toStatusCode(body[f])).find((c) => c !== undefined);
	if (code === 0) return { ok: true, status: res.status, retryable: false };
	return {
		ok: false,
		status: res.status,
		retryable: code !== undefined && retryableCodes.includes(code),
		error: JSON.stringify(body),
	};
}

/** Dingtalk custom bot: https://oapi.dingtalk.com/robot/send?access_token=xxx, signed via §9.1/9.5. */
async function sendDingtalk(config: Record<string, unknown>, text: string): Promise<DispatchResult> {
	const webhookUrl = typeof config.webhook_url === "string" ? config.webhook_url : "";
	if (!webhookUrl) return { ok: false, retryable: false, error: "missing webhook_url" };
	const secret = typeof config.secret === "string" ? config.secret : undefined;

	let url = webhookUrl;
	if (secret) {
		const timestamp = Date.now().toString();
		const sign = await hmacSha256Base64(secret, `${timestamp}\n${secret}`);
		const sep = webhookUrl.includes("?") ? "&" : "?";
		url = `${webhookUrl}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
	}

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ msgtype: "text", text: { content: text } }),
	});
	// Retryable: -1 (system busy) + the various rate-limit codes Dingtalk returns across
	// API versions/contexts (90030 "webhook over limit", 130101 "send too fast",
	// 410100, 450101). Sign/keyword/token/param errors are permanent and fail fast.
	return interpretImResponse(res, ["errcode"], [-1, 90030, 130101, 410100, 450101]);
}

/** Feishu custom bot: https://open.feishu.cn/open-apis/bot/v2/hook/xxx, signed via §9.2/9.5. */
async function sendFeishu(config: Record<string, unknown>, text: string): Promise<DispatchResult> {
	const webhookUrl = typeof config.webhook_url === "string" ? config.webhook_url : "";
	if (!webhookUrl) return { ok: false, retryable: false, error: "missing webhook_url" };
	const secret = typeof config.secret === "string" ? config.secret : undefined;

	const body: Record<string, unknown> = { msg_type: "text", content: { text } };
	if (secret) {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		body.timestamp = timestamp;
		// Feishu signs an *empty* payload using `${timestamp}\n${secret}` as the HMAC
		// key — key and message are the opposite way around from Dingtalk's scheme.
		body.sign = await hmacSha256Base64(`${timestamp}\n${secret}`, "");
	}

	const res = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	// New bots succeed with code 0, old bots with StatusCode 0; 99991400/11232 = rate limit → retry.
	return interpretImResponse(res, ["code", "StatusCode"], [99991400, 11232]);
}

/** WeCom (企业微信) group bot: no signing, the webhook key itself is the secret (§9.3). */
async function sendWework(config: Record<string, unknown>, text: string): Promise<DispatchResult> {
	const webhookUrl = typeof config.webhook_url === "string" ? config.webhook_url : "";
	if (!webhookUrl) return { ok: false, retryable: false, error: "missing webhook_url" };

	const res = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ msgtype: "text", text: { content: text } }),
	});
	// errcode 45009 = "api freq out of limit" (rate limited) → retry; 40008 etc. are permanent.
	return interpretImResponse(res, ["errcode"], [45009]);
}

/** Generic webhook: POST the raw submission as JSON, no platform-specific envelope. */
async function sendWebhook(config: Record<string, unknown>, payload: Record<string, unknown>): Promise<DispatchResult> {
	const url = typeof config.webhook_url === "string" ? config.webhook_url : "";
	if (!url) return { ok: false, retryable: false, error: "missing webhook_url" };

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	return interpretHttpResponse(res);
}

async function sendEmail(
	env: Env,
	config: Record<string, unknown>,
	form: Form,
	submission: Submission,
	subjectOverride?: string | null,
): Promise<DispatchResult> {
	const emails = Array.isArray(config.emails) ? config.emails.filter((e): e is string => typeof e === "string") : [];
	if (emails.length === 0) return { ok: false, retryable: false, error: "no emails configured" };

	try {
		await sendEmailNotification(env, {
			to: emails,
			subject: subjectOverride || `新提交 - ${form.name}`,
			html: renderSubmissionEmail(form, submission),
		});
		return { ok: true, retryable: false };
	} catch (err) {
		return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function dispatchChannel(
	env: Env,
	channel: NotificationChannel,
	form: Form,
	submission: Submission,
	subjectOverride?: string | null,
): Promise<DispatchResult> {
	const text = buildPlainTextSummary(form, submission);
	switch (channel.type) {
		case "dingtalk":
			return sendDingtalk(channel.config, text);
		case "feishu":
			return sendFeishu(channel.config, text);
		case "wework":
			return sendWework(channel.config, text);
		case "webhook":
			return sendWebhook(channel.config, {
				form: form.name,
				form_id: form.id,
				submission_id: submission.id,
				data: submission.data,
				created_at: submission.created_at,
			});
		case "email":
			return sendEmail(env, channel.config, form, submission, subjectOverride);
	}
}
