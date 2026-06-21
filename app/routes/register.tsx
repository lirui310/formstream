import { Form, Link, redirect, useActionData } from "react-router";
import type { Route } from "./+types/register";
import { createSupabaseServerClient } from "~/lib/supabase.server";

export function meta() {
	return [{ title: "注册 - FormStream" }];
}

export async function action({ request, context }: Route.ActionArgs) {
	const env = context.cloudflare.env;
	const formData = await request.formData();
	const email = String(formData.get("email") ?? "").trim();
	const password = String(formData.get("password") ?? "");

	if (password.length < 8) {
		return { error: "密码至少 8 位" };
	}

	const { supabase, headers } = createSupabaseServerClient(request, env);
	const { data, error } = await supabase.auth.signUp({ email, password });
	if (error) return { error: error.message };

	if (data.session) {
		return redirect("/dashboard", { headers });
	}
	return redirect("/login?registered=1", { headers });
}

export default function Register() {
	const actionData = useActionData<typeof action>();

	return (
		<div className="max-w-sm mx-auto mt-24 p-6">
			<h1 className="text-2xl font-semibold mb-4">注册 FormStream</h1>
			<Form method="post" className="space-y-3">
				<input name="email" type="email" placeholder="邮箱" required className="w-full border rounded px-3 py-2" />
				<input
					name="password"
					type="password"
					placeholder="密码（至少 8 位）"
					required
					minLength={8}
					className="w-full border rounded px-3 py-2"
				/>
				{actionData?.error && <p className="text-red-600 text-sm">{actionData.error}</p>}
				<button type="submit" className="w-full bg-black text-white rounded px-3 py-2">
					注册
				</button>
			</Form>
			<p className="mt-4 text-sm">
				已有账号？
				<Link to="/login" className="underline">
					登录
				</Link>
			</p>
		</div>
	);
}
