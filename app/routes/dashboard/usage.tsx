import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/usage";
import { requireSession } from "~/lib/session.server";
import { callApiJson } from "~/lib/api.server";
import { PLAN_CHANNEL_LIMITS, PLAN_FORM_LIMITS, PLAN_SUBMISSION_LIMITS } from "../../../workers/lib/plan-limits";
import type { Profile, Usage } from "../../../workers/lib/database.types";

export function meta() {
	return [{ title: "用量 - FormStream" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const ctx = context.cloudflare.ctx;

	const [profileRes, usageRes] = await Promise.all([
		callApiJson<{ success: boolean; data?: Profile }>(request.url, env, ctx, "/api/me", session.accessToken),
		callApiJson<{ success: boolean; data?: Usage[] }>(request.url, env, ctx, "/api/me/usage", session.accessToken),
	]);

	return data({ profile: profileRes.body.data, usage: usageRes.body.data ?? [] }, { headers: session.headers });
}

function firstOfMonth(): string {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export default function UsagePage() {
	const { profile, usage } = useLoaderData<typeof loader>();
	const plan = profile?.plan ?? "free";
	const used = usage.find((u) => u.period === firstOfMonth())?.count ?? 0;
	const limit = PLAN_SUBMISSION_LIMITS[plan];
	const pct = Math.min(100, Math.round((used / limit) * 100));

	return (
		<div className="max-w-xl">
			<h1 className="text-xl font-semibold mb-4">我的用量</h1>
			<p className="text-sm text-gray-500 mb-4">当前套餐：{plan}</p>

			<div className="border rounded p-4 mb-6">
				<div className="flex justify-between text-sm mb-1">
					<span>本月提交量</span>
					<span>
						{used} / {limit}
					</span>
				</div>
				<div className="bg-gray-100 rounded h-2 overflow-hidden">
					<div className="bg-black h-2" style={{ width: `${pct}%` }} />
				</div>
			</div>

			<div className="text-sm text-gray-500 space-y-1">
				<p>表单数上限：{PLAN_FORM_LIMITS[plan] ?? "不限"}</p>
				<p>每表单渠道数上限：{PLAN_CHANNEL_LIMITS[plan] ?? "不限"}</p>
			</div>

			<h2 className="font-medium mt-6 mb-2">历史用量</h2>
			<ul className="text-sm space-y-1">
				{usage.map((u) => (
					<li key={u.period}>
						{u.period}：{u.count}
					</li>
				))}
				{usage.length === 0 && <li className="text-gray-500">还没有用量记录</li>}
			</ul>
		</div>
	);
}
