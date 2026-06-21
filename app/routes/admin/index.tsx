import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/index";
import { requireSession } from "~/lib/session.server";
import { callApiJson } from "~/lib/api.server";

interface Stats {
	user_count: number;
	form_count: number;
	submission_count: number;
	spam_count: number;
	spam_rate: number;
	trend: Array<{ date: string; count: number }>;
	top_forms: Array<{ form_id: string; name: string; count: number }>;
}

export function meta() {
	return [{ title: "管理面板 - FormStream" }];
}

const EMPTY_STATS: Stats = {
	user_count: 0,
	form_count: 0,
	submission_count: 0,
	spam_count: 0,
	spam_rate: 0,
	trend: [],
	top_forms: [],
};

export async function loader({ request, context }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const { status, body } = await callApiJson<{ success: boolean; data?: Stats }>(
		request.url,
		env,
		context.cloudflare.ctx,
		"/api/admin/stats",
		session.accessToken,
	);
	const stats = status === 200 ? body.data ?? EMPTY_STATS : EMPTY_STATS;
	return data(stats, { headers: session.headers });
}

export default function AdminOverview() {
	const stats = useLoaderData<typeof loader>();
	const maxTrend = Math.max(1, ...stats.trend.map((t) => t.count));

	return (
		<div>
			<h1 className="text-xl font-semibold mb-4">平台概览</h1>
			<div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
				<Stat label="用户数" value={stats.user_count} />
				<Stat label="表单数" value={stats.form_count} />
				<Stat label="提交总量" value={stats.submission_count} />
				<Stat label="垃圾拦截率" value={`${(stats.spam_rate * 100).toFixed(1)}%`} />
			</div>

			<h2 className="font-medium mb-2">最近 14 天提交趋势</h2>
			<div className="flex items-end gap-1 h-32 border-b mb-1">
				{stats.trend.map((t) => (
					<div key={t.date} className="flex-1 flex flex-col items-center justify-end h-full" title={`${t.date}: ${t.count}`}>
						<div className="bg-black w-full" style={{ height: `${(t.count / maxTrend) * 100}%` }} />
					</div>
				))}
				{stats.trend.length === 0 && <p className="text-gray-500 text-sm pb-2">暂无数据</p>}
			</div>
			<div className="flex gap-1 text-xs text-gray-500 mb-8">
				{stats.trend.map((t) => (
					<div key={t.date} className="flex-1 text-center">
						{t.date.slice(5)}
					</div>
				))}
			</div>

			<h2 className="font-medium mb-2">Top 5 表单（近 14 天非垃圾提交量）</h2>
			<ul className="space-y-1">
				{stats.top_forms.map((f) => (
					<li key={f.form_id} className="flex justify-between border rounded px-3 py-2 text-sm">
						<span>{f.name}</span>
						<span>{f.count}</span>
					</li>
				))}
				{stats.top_forms.length === 0 && <li className="text-gray-500 text-sm">暂无数据</li>}
			</ul>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="border rounded p-4">
			<p className="text-sm text-gray-500">{label}</p>
			<p className="text-2xl font-semibold">{value}</p>
		</div>
	);
}
