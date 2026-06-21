import { data, Form, Link, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/form-detail";
import { requireSession } from "~/lib/session.server";
import { callApiJson } from "~/lib/api.server";
import type { Form as FormRow, NotificationChannel, Submission } from "../../../workers/lib/database.types";

// HMAC signing secrets shouldn't render in plaintext in the dashboard DOM.
function redactSecret(config: Record<string, unknown>): Record<string, unknown> {
	if (!config.secret) return config;
	return { ...config, secret: "••••••" };
}

const CHANNEL_TYPE_LABELS: Record<string, string> = {
	email: "邮件",
	dingtalk: "钉钉群机器人",
	feishu: "飞书群机器人",
	wework: "企业微信群机器人",
	webhook: "通用 Webhook",
};

export function meta({ data }: Route.MetaArgs) {
	return [{ title: `${data?.form.name ?? "表单"} - FormStream` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const id = params.id;
	const ctx = context.cloudflare.ctx;
	const page = new URL(request.url).searchParams.get("page") ?? "1";

	const [formRes, channelsRes, subsRes] = await Promise.all([
		callApiJson<{ success: boolean; data?: FormRow }>(request.url, env, ctx, `/api/forms/${id}`, session.accessToken),
		callApiJson<{ success: boolean; data?: NotificationChannel[] }>(
			request.url,
			env,
			ctx,
			`/api/forms/${id}/channels`,
			session.accessToken,
		),
		callApiJson<{ success: boolean; data?: Submission[]; total?: number }>(
			request.url,
			env,
			ctx,
			`/api/forms/${id}/submissions?page=${page}&size=20`,
			session.accessToken,
		),
	]);

	if (!formRes.body.data) {
		throw new Response("表单不存在", { status: 404 });
	}

	// Redact here, not just at render time — the loader's return value is also
	// serialized into the page's hydration payload, so masking only in JSX would
	// still leak the raw secret into the page source.
	const channels = (channelsRes.body.data ?? []).map((ch) => ({ ...ch, config: redactSecret(ch.config) }));

	return data(
		{
			form: formRes.body.data,
			channels,
			submissions: subsRes.body.data ?? [],
			total: subsRes.body.total ?? 0,
			page: Number(page),
		},
		{ headers: session.headers },
	);
}

export async function action({ request, context, params }: Route.ActionArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const id = params.id;
	const ctx = context.cloudflare.ctx;
	const formData = await request.formData();
	const intent = String(formData.get("intent") ?? "");

	// Every branch funnels through these two so a failed API call always surfaces an
	// error instead of silently falling through to the success return, and every
	// response (success or error) carries session.headers so a refreshed auth cookie
	// from requireSession is never dropped.
	const fail = (message: string) => data({ error: message }, { headers: session.headers });
	const ok = (extra?: Record<string, unknown>) => data({ ok: true, ...extra }, { headers: session.headers });

	if (intent === "add-channel") {
		const type = String(formData.get("type") ?? "email");
		let config: Record<string, unknown>;
		if (type === "email") {
			const emails = String(formData.get("emails") ?? "")
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean);
			if (emails.length === 0) return fail("请填写至少一个邮箱");
			config = { emails };
		} else {
			const webhookUrl = String(formData.get("webhook_url") ?? "").trim();
			if (!webhookUrl) return fail("请填写 webhook 地址");
			config = { webhook_url: webhookUrl };
			const secret = String(formData.get("secret") ?? "").trim();
			if (secret && (type === "dingtalk" || type === "feishu")) config.secret = secret;
		}

		const { status, body } = await callApiJson<{ success: boolean; message?: string }>(
			request.url,
			env,
			ctx,
			`/api/forms/${id}/channels`,
			session.accessToken,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, config }) },
		);
		if (status !== 200) return fail(body.message ?? "添加失败");
		return ok();
	}

	if (intent === "delete-channel") {
		const channelId = String(formData.get("channel_id") ?? "");
		const { status, body } = await callApiJson<{ message?: string }>(
			request.url,
			env,
			ctx,
			`/api/channels/${channelId}`,
			session.accessToken,
			{ method: "DELETE" },
		);
		if (status !== 200) return fail(body.message ?? "删除渠道失败");
		return ok();
	}

	if (intent === "test-channel") {
		const channelId = String(formData.get("channel_id") ?? "");
		const { status, body } = await callApiJson<{ success: boolean; message?: string }>(
			request.url,
			env,
			ctx,
			`/api/channels/${channelId}/test`,
			session.accessToken,
			{ method: "POST" },
		);
		if (status !== 200) return fail(`测试失败：${body.message ?? "未知错误"}`);
		return ok({ testedChannel: channelId });
	}

	if (intent === "delete-submission") {
		const submissionId = String(formData.get("submission_id") ?? "");
		const { status, body } = await callApiJson<{ message?: string }>(
			request.url,
			env,
			ctx,
			`/api/submissions/${submissionId}`,
			session.accessToken,
			{ method: "DELETE" },
		);
		if (status !== 200) return fail(body.message ?? "删除提交失败");
		return ok();
	}

	if (intent === "toggle-active") {
		const isActive = String(formData.get("is_active")) === "true";
		const { status, body } = await callApiJson<{ message?: string }>(
			request.url,
			env,
			ctx,
			`/api/forms/${id}`,
			session.accessToken,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_active: !isActive }) },
		);
		if (status !== 200) return fail(body.message ?? "更新失败");
		return ok();
	}

	if (intent === "toggle-turnstile") {
		const enabled = String(formData.get("turnstile_enabled")) === "true";
		const { status, body } = await callApiJson<{ message?: string }>(
			request.url,
			env,
			ctx,
			`/api/forms/${id}`,
			session.accessToken,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ turnstile_enabled: !enabled }),
			},
		);
		if (status !== 200) return fail(body.message ?? "更新失败");
		return ok();
	}

	return fail("unknown intent");
}

export default function FormDetail() {
	const { form, channels, submissions, total, page } = useLoaderData<typeof loader>();
	const actionData = useActionData<typeof action>();

	return (
		<div className="space-y-8 max-w-3xl">
			<div>
				<h1 className="text-xl font-semibold">{form.name}</h1>
				<p className="text-sm text-gray-500 mt-1">
					access_key: <code>{form.access_key}</code>
				</p>
				<p className="text-sm text-gray-500">状态：{form.is_active ? "启用" : "停用"}</p>
				<Form method="post" className="mt-2 inline-block mr-4">
					<input type="hidden" name="intent" value="toggle-active" />
					<input type="hidden" name="is_active" value={String(form.is_active)} />
					<button type="submit" className="text-sm underline">
						{form.is_active ? "停用此表单" : "启用此表单"}
					</button>
				</Form>
				<Form method="post" className="mt-2 inline-block">
					<input type="hidden" name="intent" value="toggle-turnstile" />
					<input type="hidden" name="turnstile_enabled" value={String(form.turnstile_enabled)} />
					<button type="submit" className="text-sm underline">
						{form.turnstile_enabled ? "关闭 Turnstile 人机验证" : "开启 Turnstile 人机验证"}
					</button>
				</Form>
				<div className="mt-3 bg-gray-50 border rounded p-3 text-sm">
					<p className="mb-1 font-medium">接入方式：把表单 action 指向这个地址</p>
					<code className="block break-all">{`<form action="https://<你的域名>/s/${form.access_key}" method="POST">`}</code>
					{form.turnstile_enabled && (
						<p className="mt-2 text-amber-700">
							已开启 Turnstile：需要在表单页面里嵌入 Turnstile 小组件，并把
							<code className="mx-1">cf-turnstile-response</code>
							字段一起提交。
						</p>
					)}
				</div>
			</div>

			<div>
				<h2 className="font-medium mb-2">通知渠道</h2>
				<ul className="space-y-1 mb-3">
					{channels.map((ch) => (
						<li key={ch.id} className="flex items-center justify-between border rounded px-3 py-2 text-sm">
							<span>
								{CHANNEL_TYPE_LABELS[ch.type] ?? ch.type} · {JSON.stringify(ch.config)}
							</span>
							<div className="flex gap-3">
								<Form method="post">
									<input type="hidden" name="intent" value="test-channel" />
									<input type="hidden" name="channel_id" value={ch.id} />
									<button type="submit" className="underline">
										测试
									</button>
								</Form>
								<Form method="post">
									<input type="hidden" name="intent" value="delete-channel" />
									<input type="hidden" name="channel_id" value={ch.id} />
									<button type="submit" className="text-red-600 underline">
										删除
									</button>
								</Form>
							</div>
						</li>
					))}
					{channels.length === 0 && <li className="text-gray-500 text-sm">还没有配置通知渠道</li>}
				</ul>

				<Form method="post" className="space-y-2 border rounded p-3">
					<input type="hidden" name="intent" value="add-channel" />
					<div>
						<label className="block text-sm mb-1">渠道类型</label>
						<select name="type" className="border rounded px-3 py-2 text-sm" defaultValue="email">
							<option value="email">邮件</option>
							<option value="dingtalk">钉钉群机器人</option>
							<option value="feishu">飞书群机器人</option>
							<option value="wework">企业微信群机器人</option>
							<option value="webhook">通用 Webhook</option>
						</select>
					</div>
					<div>
						<label className="block text-sm mb-1">接收邮箱（仅邮件渠道需要，逗号分隔）</label>
						<input name="emails" placeholder="a@example.com, b@example.com" className="w-full border rounded px-3 py-2 text-sm" />
					</div>
					<div>
						<label className="block text-sm mb-1">Webhook 地址（钉钉/飞书/企微/通用 webhook 需要）</label>
						<input name="webhook_url" placeholder="https://..." className="w-full border rounded px-3 py-2 text-sm" />
					</div>
					<div>
						<label className="block text-sm mb-1">加签密钥（仅钉钉/飞书可选）</label>
						<input name="secret" placeholder="留空则不加签" className="w-full border rounded px-3 py-2 text-sm" />
					</div>
					<button type="submit" className="bg-black text-white rounded px-3 py-2 text-sm">
						添加渠道
					</button>
				</Form>
				{actionData && "error" in actionData && (
					<p className="text-red-600 text-sm mt-1">{actionData.error}</p>
				)}
				{actionData && "testedChannel" in actionData && (
					<p className="text-green-700 text-sm mt-1">测试通知已发送，去对应渠道查看</p>
				)}
			</div>

			<div>
				<div className="flex items-center justify-between mb-2">
					<h2 className="font-medium">提交记录（共 {total} 条）</h2>
					<a href={`/dashboard/forms/${form.id}/export`} className="text-sm underline">
						导出 CSV
					</a>
				</div>
				<ul className="space-y-2">
					{submissions.map((s) => (
						<li key={s.id} className="border rounded p-3 text-sm">
							<div className="flex items-center justify-between">
								<span className="text-gray-500">
									{s.created_at} · {s.ip}
									{s.is_spam ? " · 垃圾" : ""}
								</span>
								<Form method="post">
									<input type="hidden" name="intent" value="delete-submission" />
									<input type="hidden" name="submission_id" value={s.id} />
									<button type="submit" className="text-red-600 underline">
										删除
									</button>
								</Form>
							</div>
							<pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(s.data, null, 2)}</pre>
							{s.files.length > 0 && (
								<ul className="mt-1 flex flex-wrap gap-3">
									{s.files.map((f, idx) => (
										<li key={f.key}>
											<a href={`/dashboard/submissions/${s.id}/files/${idx}`} className="underline text-blue-700">
												📎 {f.name}
											</a>
										</li>
									))}
								</ul>
							)}
						</li>
					))}
					{submissions.length === 0 && <li className="text-gray-500 text-sm">还没有提交记录</li>}
				</ul>
				<div className="flex gap-3 mt-3 text-sm">
					{page > 1 && <Link to={`?page=${page - 1}`}>上一页</Link>}
					{page * 20 < total && <Link to={`?page=${page + 1}`}>下一页</Link>}
				</div>
			</div>
		</div>
	);
}
