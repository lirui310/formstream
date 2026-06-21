import type { Route } from "./+types/file-download";
import { requireSession } from "~/lib/session.server";
import { createSupabaseServerClient } from "~/lib/supabase.server";

/**
 * Resource route (no UI) for downloading a submission's attached file. A plain <a
 * href> can't carry an Authorization header, so this goes through the cookie-based
 * SSR client (RLS-scoped to the logged-in user) instead of the bearer-only /api/*
 * layer — the one deliberate exception to "dashboard writes/reads go through /api/*".
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	await requireSession(request, env);
	const { supabase } = createSupabaseServerClient(request, env);

	const { data: submission } = await supabase
		.from("submissions")
		.select("files")
		.eq("id", params.id)
		.maybeSingle();
	if (!submission) throw new Response("not found", { status: 404 });

	const file = submission.files[Number(params.idx)];
	if (!file) throw new Response("not found", { status: 404 });

	const object = await env.UPLOADS.get(file.key);
	if (!object) throw new Response("file missing from storage", { status: 404 });

	return new Response(object.body, {
		headers: {
			"Content-Type": file.type || "application/octet-stream",
			"Content-Disposition": `attachment; filename="${encodeURIComponent(file.name)}"`,
		},
	});
}
