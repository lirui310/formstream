import { data, Link } from "react-router";
import type { Route } from "./+types/home";
import { getOptionalSession } from "~/lib/session.server";

export function meta() {
	return [
		{ title: "FormStream — 表单后端服务" },
		{
			name: "description",
			content: "给静态网站用的表单后端服务，一个 access_key 零后端代码收表单，提交后直接推钉钉/飞书/企业微信/邮件通知。",
		},
	];
}

export async function loader({ request, context }: Route.LoaderArgs) {
	const session = await getOptionalSession(request, context.cloudflare.env);
	return data({ loggedIn: Boolean(session) }, session ? { headers: session.headers } : undefined);
}

export default function Home({ loaderData }: Route.ComponentProps) {
	const { loggedIn } = loaderData;

	return (
		<div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
			<h1 className="text-3xl font-bold mb-3">FormStream</h1>
			<p className="text-gray-600 max-w-md mb-8">
				给静态网站用的表单后端服务。一个 access_key，零后端代码收表单，提交后直接推钉钉 / 飞书 / 企业微信 / 邮件通知。
			</p>
			<div className="flex gap-3">
				{loggedIn ? (
					<Link to="/dashboard" className="bg-black text-white rounded px-5 py-2 text-sm">
						进入后台
					</Link>
				) : (
					<>
						<Link to="/login" className="bg-black text-white rounded px-5 py-2 text-sm">
							登录
						</Link>
						<Link to="/register" className="border rounded px-5 py-2 text-sm">
							注册
						</Link>
					</>
				)}
			</div>
		</div>
	);
}
