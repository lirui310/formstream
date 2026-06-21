export async function sendEmailNotification(
	env: Env,
	params: { to: string[]; subject: string; html: string },
): Promise<void> {
	if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");

	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		// onboarding@resend.dev works without a verified sending domain; swap once
		// a custom domain is verified in Resend (see docs §9.4 / 前期准备清单 §Resend).
		body: JSON.stringify({
			from: "FormStream <onboarding@resend.dev>",
			to: params.to,
			subject: params.subject,
			html: params.html,
		}),
	});

	if (!res.ok) {
		throw new Error(`Resend API error ${res.status}: ${await res.text()}`);
	}
}
