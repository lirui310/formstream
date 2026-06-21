import { Form, redirect, useActionData } from "react-router";
import type { Route } from "./+types/new";
import { requireSession } from "~/lib/session.server";
import { callApiJson } from "~/lib/api.server";

export function meta() {
	return [{ title: "新建表单 - FormStream" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	await requireSession(request, context.cloudflare.env);
	return null;
}

export async function action({ request, context }: Route.ActionArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const formData = await request.formData();
	const name = String(formData.get("name") ?? "").trim();
	const allowed_domains = String(formData.get("allowed_domains") ?? "")
		.split(",")
		.map((d) => d.trim())
		.filter(Boolean);

	if (!name) return { error: "请填写表单名称" };

	const { status, body } = await callApiJson<{ success: boolean; data?: { id: string }; message?: string }>(
		request.url,
		env,
		context.cloudflare.ctx,
		"/api/forms",
		session.accessToken,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, allowed_domains }),
		},
	);

	if (status !== 200 || !body.data) {
		return { error: body.message ?? "创建失败" };
	}
	return redirect(`/dashboard/forms/${body.data.id}`, { headers: session.headers });
}

export default function NewForm() {
	const actionData = useActionData<typeof action>();

	return (
		<div className="max-w-md">
			<h1 className="text-xl font-semibold mb-4">新建表单</h1>
			<Form method="post" className="space-y-3">
				<div>
					<label className="block text-sm mb-1">表单名称</label>
					<input name="name" required className="w-full border rounded px-3 py-2" />
				</div>
				<div>
					<label className="block text-sm mb-1">允许的域名（逗号分隔，留空表示不限制）</label>
					<input name="allowed_domains" placeholder="example.com, www.example.com" className="w-full border rounded px-3 py-2" />
				</div>
				{actionData?.error && <p className="text-red-600 text-sm">{actionData.error}</p>}
				<button type="submit" className="bg-black text-white rounded px-3 py-2 text-sm">
					创建
				</button>
			</Form>
		</div>
	);
}
