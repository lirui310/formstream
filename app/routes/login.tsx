import { Form, Link, redirect, useActionData, useSearchParams } from "react-router";
import type { Route } from "./+types/login";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { createAdminClient } from "../../workers/lib/supabase-admin";

export function meta() {
	return [{ title: "登录 - FormStream" }];
}

export async function action({ request, context }: Route.ActionArgs) {
	const env = context.cloudflare.env;
	const formData = await request.formData();
	const email = String(formData.get("email") ?? "").trim();
	const password = String(formData.get("password") ?? "");

	const { supabase, headers } = createSupabaseServerClient(request, env);
	const { data, error } = await supabase.auth.signInWithPassword({ email, password });
	if (error || !data.session) {
		return { error: error?.message ?? "登录失败" };
	}

	// First-admin bootstrap (docs §5.2): promote on login if the email is configured
	// as an admin and isn't already one.
	const adminEmails = (env.ADMIN_EMAILS ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	if (email && adminEmails.includes(email.toLowerCase())) {
		const admin = createAdminClient(env);
		await admin.from("profiles").update({ role: "admin" }).eq("id", data.session.user.id).neq("role", "admin");
	}

	return redirect("/dashboard", { headers });
}

export default function Login() {
	const actionData = useActionData<typeof action>();
	const [searchParams] = useSearchParams();

	return (
		<div className="max-w-sm mx-auto mt-24 p-6">
			<h1 className="text-2xl font-semibold mb-4">登录 FormStream</h1>
			{searchParams.get("suspended") && <p className="text-red-600 text-sm mb-3">账号已被停用</p>}
			{searchParams.get("registered") && (
				<p className="text-green-700 text-sm mb-3">注册成功，请检查邮箱完成验证后登录</p>
			)}
			<Form method="post" className="space-y-3">
				<input name="email" type="email" placeholder="邮箱" required className="w-full border rounded px-3 py-2" />
				<input
					name="password"
					type="password"
					placeholder="密码"
					required
					className="w-full border rounded px-3 py-2"
				/>
				{actionData?.error && <p className="text-red-600 text-sm">{actionData.error}</p>}
				<button type="submit" className="w-full bg-black text-white rounded px-3 py-2">
					登录
				</button>
			</Form>
			<p className="mt-4 text-sm">
				还没有账号？
				<Link to="/register" className="underline">
					注册
				</Link>
			</p>
		</div>
	);
}
