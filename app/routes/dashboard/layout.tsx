import { data, Form, Link, Outlet, useLoaderData } from "react-router";
import type { Route } from "./+types/layout";
import { requireSession } from "~/lib/session.server";

export async function loader({ request, context }: Route.LoaderArgs) {
	const session = await requireSession(request, context.cloudflare.env);
	return data({ email: session.email, role: session.role }, { headers: session.headers });
}

export default function DashboardLayout() {
	const { email, role } = useLoaderData<typeof loader>();

	return (
		<div className="min-h-screen">
			<header className="border-b flex items-center justify-between px-6 py-3">
				<Link to="/dashboard" className="font-semibold">
					FormStream
				</Link>
				<div className="flex items-center gap-3 text-sm">
					<Link to="/dashboard/usage" className="underline">
						用量
					</Link>
					{role === "admin" && (
						<Link to="/admin" className="underline">
							管理面板
						</Link>
					)}
					<span>
						{email}
						{role === "admin" && " · 管理员"}
					</span>
					<Form method="post" action="/logout">
						<button type="submit" className="underline">
							退出登录
						</button>
					</Form>
				</div>
			</header>
			<main className="p-6">
				<Outlet />
			</main>
		</div>
	);
}
