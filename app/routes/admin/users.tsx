import { data, Form, useLoaderData } from "react-router";
import type { Route } from "./+types/users";
import { requireSession } from "~/lib/session.server";
import { callApiJson } from "~/lib/api.server";

interface AdminUser {
	id: string;
	email: string | null;
	created_at: string;
	role: "user" | "admin";
	status: "active" | "suspended";
	plan: "free" | "pro" | "business";
}

export function meta() {
	return [{ title: "用户管理 - FormStream" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const q = new URL(request.url).searchParams.get("q") ?? "";
	const { body } = await callApiJson<{ success: boolean; data: AdminUser[]; total: number }>(
		request.url,
		env,
		context.cloudflare.ctx,
		`/api/admin/users?q=${encodeURIComponent(q)}`,
		session.accessToken,
	);
	return data({ users: body.data ?? [], total: body.total ?? 0, q }, { headers: session.headers });
}

export async function action({ request, context }: Route.ActionArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const ctx = context.cloudflare.ctx;
	const formData = await request.formData();
	const intent = String(formData.get("intent") ?? "");
	const userId = String(formData.get("user_id") ?? "");

	if (intent === "update") {
		await callApiJson(request.url, env, ctx, `/api/admin/users/${userId}`, session.accessToken, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				plan: String(formData.get("plan") ?? ""),
				status: String(formData.get("status") ?? ""),
				role: String(formData.get("role") ?? ""),
			}),
		});
	} else if (intent === "delete") {
		await callApiJson(request.url, env, ctx, `/api/admin/users/${userId}`, session.accessToken, {
			method: "DELETE",
		});
	}

	return data({ ok: true }, { headers: session.headers });
}

export default function AdminUsers() {
	const { users, total, q } = useLoaderData<typeof loader>();

	return (
		<div>
			<h1 className="text-xl font-semibold mb-4">用户管理（共 {total} 人）</h1>
			<Form method="get" className="mb-4">
				<input name="q" defaultValue={q} placeholder="按邮箱搜索" className="border rounded px-3 py-2 text-sm" />
				<button type="submit" className="ml-2 bg-black text-white rounded px-3 py-2 text-sm">
					搜索
				</button>
			</Form>
			<table className="w-full text-sm border-collapse">
				<thead>
					<tr className="text-left border-b">
						<th className="py-2">邮箱</th>
						<th>角色</th>
						<th>状态</th>
						<th>套餐</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{users.map((u) => (
						<tr key={u.id} className="border-b">
							<td className="py-2">{u.email}</td>
							<td>{u.role}</td>
							<td>{u.status}</td>
							<td>{u.plan}</td>
							<td>
								<Form method="post" className="flex items-center gap-1">
									<input type="hidden" name="intent" value="update" />
									<input type="hidden" name="user_id" value={u.id} />
									<select name="plan" defaultValue={u.plan} className="border rounded text-xs px-1 py-1">
										<option value="free">free</option>
										<option value="pro">pro</option>
										<option value="business">business</option>
									</select>
									<select name="status" defaultValue={u.status} className="border rounded text-xs px-1 py-1">
										<option value="active">active</option>
										<option value="suspended">suspended</option>
									</select>
									<select name="role" defaultValue={u.role} className="border rounded text-xs px-1 py-1">
										<option value="user">user</option>
										<option value="admin">admin</option>
									</select>
									<button type="submit" className="underline text-xs">
										保存
									</button>
								</Form>
								<Form method="post" className="inline">
									<input type="hidden" name="intent" value="delete" />
									<input type="hidden" name="user_id" value={u.id} />
									<button type="submit" className="text-red-600 underline text-xs ml-2">
										删除
									</button>
								</Form>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
