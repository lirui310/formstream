import { data, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/index";
import { requireSession } from "~/lib/session.server";
import { callApiJson } from "~/lib/api.server";
import type { Form as FormRow } from "../../../workers/lib/database.types";

export function meta() {
	return [{ title: "我的表单 - FormStream" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	const { body } = await callApiJson<{ success: boolean; data?: FormRow[] }>(
		request.url,
		env,
		context.cloudflare.ctx,
		"/api/forms",
		session.accessToken,
	);
	return data({ forms: body.data ?? [] }, { headers: session.headers });
}

export default function DashboardIndex() {
	const { forms } = useLoaderData<typeof loader>();

	return (
		<div>
			<div className="flex items-center justify-between mb-4">
				<h1 className="text-xl font-semibold">我的表单</h1>
				<Link to="/dashboard/new" className="bg-black text-white rounded px-3 py-2 text-sm">
					+ 新建表单
				</Link>
			</div>
			{forms.length === 0 && <p className="text-gray-500">还没有表单，点右上角新建一个。</p>}
			<ul className="space-y-2">
				{forms.map((f) => (
					<li key={f.id} className="border rounded p-3 flex items-center justify-between">
						<div>
							<Link to={`/dashboard/forms/${f.id}`} className="font-medium underline">
								{f.name}
							</Link>
							<p className="text-xs text-gray-500">
								access_key: {f.access_key} · {f.is_active ? "启用" : "停用"}
							</p>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
