import { data, Form, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/forms";
import { requireSession } from "~/lib/session.server";
import { callApiJson } from "~/lib/api.server";
import type { Form as FormRow } from "../../../workers/lib/database.types";

export function meta() {
	return [{ title: "全局表单 - FormStream" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const q = new URL(request.url).searchParams.get("q") ?? "";
	const { body } = await callApiJson<{ success: boolean; data: FormRow[] }>(
		request.url,
		env,
		context.cloudflare.ctx,
		`/api/admin/forms?q=${encodeURIComponent(q)}`,
		session.accessToken,
	);
	return data({ forms: body.data ?? [], q }, { headers: session.headers });
}

export async function action({ request, context }: Route.ActionArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const formData = await request.formData();
	const formId = String(formData.get("form_id") ?? "");
	const isActive = String(formData.get("is_active")) === "true";
	const { status, body } = await callApiJson<{ message?: string }>(
		request.url,
		env,
		context.cloudflare.ctx,
		`/api/admin/forms/${formId}`,
		session.accessToken,
		{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_active: !isActive }) },
	);
	if (status !== 200) return data({ error: body.message ?? "操作失败" }, { headers: session.headers });
	return data({ ok: true }, { headers: session.headers });
}

export default function AdminForms() {
	const { forms, q } = useLoaderData<typeof loader>();
	const actionData = useActionData<typeof action>();

	return (
		<div>
			<h1 className="text-xl font-semibold mb-4">全局表单检索</h1>
			{actionData && "error" in actionData && <p className="text-red-600 text-sm mb-2">{actionData.error}</p>}
			<Form method="get" className="mb-4">
				<input
					name="q"
					defaultValue={q}
					placeholder="按名称或 access_key 搜索"
					className="border rounded px-3 py-2 text-sm w-64"
				/>
				<button type="submit" className="ml-2 bg-black text-white rounded px-3 py-2 text-sm">
					搜索
				</button>
			</Form>
			<ul className="space-y-2">
				{forms.map((f) => (
					<li key={f.id} className="border rounded p-3 text-sm flex items-center justify-between">
						<div>
							<p className="font-medium">{f.name}</p>
							<p className="text-gray-500">
								access_key: {f.access_key} · user_id: {f.user_id} · {f.is_active ? "启用" : "停用"}
							</p>
						</div>
						<Form method="post">
							<input type="hidden" name="form_id" value={f.id} />
							<input type="hidden" name="is_active" value={String(f.is_active)} />
							<button type="submit" className="text-sm underline">
								{f.is_active ? "强制停用" : "启用"}
							</button>
						</Form>
					</li>
				))}
				{forms.length === 0 && <li className="text-gray-500 text-sm">没有匹配的表单</li>}
			</ul>
		</div>
	);
}
