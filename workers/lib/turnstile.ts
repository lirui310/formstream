export async function verifyTurnstile(token: string, secret: string, ip: string): Promise<boolean> {
	if (!token) return false;
	const body = new FormData();
	body.append("secret", secret);
	body.append("response", token);
	body.append("remoteip", ip);

	const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		body,
	});
	if (!res.ok) throw new Error(`Turnstile Siteverify returned HTTP ${res.status}`);

	const result: unknown = await res.json();
	if (typeof result !== "object" || result === null || !("success" in result) || typeof result.success !== "boolean") {
		throw new Error("Turnstile Siteverify returned an invalid response");
	}
	return result.success;
}
