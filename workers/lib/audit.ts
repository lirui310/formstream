import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

interface LogAuditParams {
	/** Omit for system-generated entries (e.g. a queue consumer logging a permanent delivery failure). */
	actorId?: string;
	actorEmail?: string;
	action: string;
	targetType: string;
	targetId?: string;
	detail?: Record<string, unknown>;
}

/** Fire-and-forget-ish action log (admin actions or system events). A failure here must never block the action it's logging. */
export async function logAudit(admin: SupabaseClient<Database>, params: LogAuditParams): Promise<void> {
	const { error } = await admin.from("audit_logs").insert({
		actor_id: params.actorId ?? null,
		actor_email: params.actorEmail ?? null,
		action: params.action,
		target_type: params.targetType,
		target_id: params.targetId ?? null,
		detail: params.detail ?? {},
	});
	if (error) console.error("audit log write failed", error);
}
