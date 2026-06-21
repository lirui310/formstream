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

async function interpretResponse(res: Response): Promise<DispatchResult> {
	if (res.ok) return { ok: true, status: res.status, retryable: false };
	// 429 = IM platform rate limit (docs §9: dingtalk ~20/min, feishu ~100/min, wework ~20/min); 5xx = transient.
	const retryable = res.status === 429 || res.status >= 500;
	return { ok: false, status: res.status, retryable, error: await res.text().catch(() => res.statusText) };
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
	return interpretResponse(res);
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
		body.sign = await hmacSha256Base64(secret, `${timestamp}\n${secret}`);
	}

	const res = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return interpretResponse(res);
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
	return interpretResponse(res);
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
	return interpretResponse(res);
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
