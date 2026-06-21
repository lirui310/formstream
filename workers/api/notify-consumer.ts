import { createAdminClient } from "../lib/supabase-admin";
import { dispatchChannel } from "../lib/notify-channels";
import { logAudit } from "../lib/audit";
import type { NotifyMessage } from "../lib/notify-types";

export async function handleNotifyQueue(batch: MessageBatch<NotifyMessage>, env: Env): Promise<void> {
	const admin = createAdminClient(env);
	for (const message of batch.messages) {
		try {
			const allOk = await deliver(admin, env, message.body);
			if (allOk) {
				message.ack();
			} else {
				message.retry({ delaySeconds: backoffSeconds(message.attempts) });
			}
		} catch (err) {
			console.error("notify delivery failed", err);
			message.retry({ delaySeconds: backoffSeconds(message.attempts) });
		}
	}
}

/** 15s, 30s, 60s, ... capped at 10min — stays under the IM platforms' own rate-limit cool-downs (docs §9). */
function backoffSeconds(attempts: number): number {
	return Math.min(15 * 2 ** Math.max(0, attempts - 1), 600);
}

/**
 * Returns whether every active channel delivered successfully. A single message
 * fans out to every channel on the form, so a retry resends to channels that
 * already succeeded too — acceptable at MVP scale (docs don't require dedup),
 * not worth the complexity of per-channel sub-messages yet.
 */
async function deliver(
	admin: ReturnType<typeof createAdminClient>,
	env: Env,
	payload: NotifyMessage,
): Promise<boolean> {
	const { data: submission, error: submissionError } = await admin
		.from("submissions")
		.select("*")
		.eq("id", payload.submissionId)
		.maybeSingle();
	if (submissionError) throw new Error(`failed to load submission: ${submissionError.message}`);
	if (!submission) return true;

	const { data: form, error: formError } = await admin
		.from("forms")
		.select("*")
		.eq("id", payload.formId)
		.maybeSingle();
	if (formError) throw new Error(`failed to load form: ${formError.message}`);
	if (!form) return true;

	const { data: channels, error: channelsError } = await admin
		.from("notification_channels")
		.select("*")
		.eq("form_id", payload.formId)
		.eq("is_active", true);
	if (channelsError) throw new Error(`failed to load notification channels: ${channelsError.message}`);
	if (!channels || channels.length === 0) return true;

	let allOk = true;
	for (const channel of channels) {
		const result = await dispatchChannel(env, channel, form, submission, payload.subject);
		if (!result.ok) {
			console.error(`channel ${channel.id} (${channel.type}) delivery failed: ${result.error}`);
			if (result.retryable) {
				allOk = false;
			} else {
				// Permanent failures (bad config, deleted webhook) would otherwise be
				// ack()'d and vanish with zero trace — record it so the form owner/admin
				// can actually discover a "silently broken" channel via /admin/logs.
				await logAudit(admin, {
					actorId: form.user_id,
					action: "channel.delivery_failed",
					targetType: "notification_channel",
					targetId: channel.id,
					detail: { channelType: channel.type, formId: form.id, error: result.error },
				});
			}
		}
	}
	return allOk;
}
