import { Link, Outlet, redirect } from "react-router";
import type { Route } from "./+types/layout";
import { requireSession } from "~/lib/session.server";

export async function loader({ request, context }: Route.LoaderArgs) {
	const session = await requireSession(request, context.cloudflare.env);
	if (session.role !== "admin") {
		// Front-end guard only — every /api/admin/* call is independently re-checked
		// server-side against profiles.role (docs §5.4), so this redirect is UX, not security.
		throw redirect("/dashboard");
	}
	return null;
}

export default function AdminLayout() {
	return (
		<div>
			<nav className="flex gap-4 mb-6 text-sm border-b pb-3">
				<Link to="/admin" className="underline">
					概览
				</Link>
				<Link to="/admin/users" className="underline">
					用户管理
				</Link>
				<Link to="/admin/forms" className="underline">
					全局表单
				</Link>
				<Link to="/admin/logs" className="underline">
					操作日志
				</Link>
				<Link to="/dashboard" className="underline ml-auto">
					返回我的后台
				</Link>
			</nav>
			<Outlet />
		</div>
	);
}
