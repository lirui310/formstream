import { createRequestHandler } from "react-router";
import apiApp from "./api";
import { handleNotifyQueue } from "./api/notify-consumer";
import type { NotifyMessage } from "./lib/notify-types";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

export default {
	fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname.startsWith("/s/") || pathname.startsWith("/api/")) {
			return apiApp.fetch(request, env, ctx);
		}
		return requestHandler(request, {
			cloudflare: { env, ctx },
		});
	},
	queue(batch, env) {
		return handleNotifyQueue(batch, env);
	},
} satisfies ExportedHandler<Env, NotifyMessage>;
