import type { Route } from "./+types/export-csv";
import { requireSession } from "~/lib/session.server";
import { callApi } from "~/lib/api.server";

/** Resource route: a plain <a href> can't carry the Authorization header the
 * /api/* export endpoint needs, so this proxies the in-process API call using
 * the cookie session's access token and passes the CSV Response straight through. */
export async function loader({ request, context, params }: Route.LoaderArgs) {
	const env = context.cloudflare.env;
	const session = await requireSession(request, env);
	return callApi(
		request.url,
		env,
		context.cloudflare.ctx,
		`/api/forms/${params.id}/submissions/export`,
		session.accessToken,
	);
}
