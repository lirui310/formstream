// Secrets configured via `.dev.vars` locally / `wrangler secret put` in production.
// Not part of wrangler.json, so `wrangler types` won't generate these — declared by hand.
interface Env {
	SUPABASE_ANON_KEY: string;
	SUPABASE_SERVICE_KEY: string;
	RESEND_API_KEY?: string;
	ADMIN_EMAILS?: string;
	TURNSTILE_SECRET?: string;
}
