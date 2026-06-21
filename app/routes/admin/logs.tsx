import { data, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/logs";
import { requireSession } from "~/lib/session.server";
import { callApiJson } from "~/lib/api.server";
import type { AuditLog } from "../../../workers/lib/database.types";

export function meta() {
	return [{ title: "操作日志 - FormStream" }];
}

const ACTION_LABELS: Record<string, string> = {
	"user.update": "修改用户(套餐/状态/角色)",
	"user.delete": "删除用户",
	"form.force_disable": "强制停用表单",
	"form.enable": "启用表单",
	"channel.delivery_failed": "通知渠道投递失败(永久错误)",
};

export async function loader({ request, context }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const page = new URL(request.url).searchParams.get("page") ?? "1";
	const { body } = await callApiJson<{ success: boolean; data?: AuditLog[]; total?: number }>(
		request.url,
		env,
		context.cloudflare.ctx,
		`/api/admin/logs?page=${page}&size=30`,
		session.accessToken,
	);
	return data(
		{ logs: body.data ?? [], total: body.total ?? 0, page: Number(page) },
		{ headers: session.headers },
	);
}

export default function AdminLogs() {
	const { logs, total, page } = useLoaderData<typeof loader>();

	return (
		<div>
			<h1 className="text-xl font-semibold mb-4">操作日志（共 {total} 条）</h1>
			<ul className="space-y-2">
				{logs.map((log) => (
					<li key={log.id} className="border rounded p-3 text-sm">
						<div className="flex justify-between">
							<span className="font-medium">{ACTION_LABELS[log.action] ?? log.action}</span>
							<span className="text-gray-500">{log.created_at}</span>
						</div>
						<p className="text-gray-500 mt-1">
							操作人：{log.actor_email ?? log.actor_id} · 目标：{log.target_type} {log.target_id}
						</p>
						{Object.keys(log.detail).length > 0 && (
							<pre className="mt-1 text-gray-600 whitespace-pre-wrap break-all">{JSON.stringify(log.detail)}</pre>
						)}
					</li>
				))}
				{logs.length === 0 && <li className="text-gray-500 text-sm">还没有操作记录</li>}
			</ul>
			<div className="flex gap-3 mt-3 text-sm">
				{page > 1 && <Link to={`?page=${page - 1}`}>上一页</Link>}
				{page * 30 < total && <Link to={`?page=${page + 1}`}>下一页</Link>}
			</div>
		</div>
	);
}
