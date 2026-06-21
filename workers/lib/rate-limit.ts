/** Fixed-window counter in KV. Good enough for MVP-scale traffic; not exact under races. */
export async function checkRateLimit(
	kv: KVNamespace,
	key: string,
	limit: number,
	windowSeconds: number,
): Promise<boolean> {
	const current = await kv.get(key);
	const count = current ? Number(current) : 0;
	if (count >= limit) return false;
	await kv.put(key, String(count + 1), { expirationTtl: windowSeconds });
	return true;
}
