import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { createSupabaseServerClient } from "~/lib/supabase.server";

export async function action({ request, context }: Route.ActionArgs) {
	const env = context.cloudflare.env;
	const { supabase, headers } = createSupabaseServerClient(request, env);
	await supabase.auth.signOut();
	return redirect("/login", { headers });
}

export async function loader() {
	return redirect("/login");
}
