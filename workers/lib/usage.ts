import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

function firstOfMonth(): string {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export async function getCurrentMonthUsageCount(admin: SupabaseClient<Database>, userId: string): Promise<number> {
	const { data } = await admin
		.from("usage")
		.select("count")
		.eq("user_id", userId)
		.eq("period", firstOfMonth())
		.maybeSingle();
	return data?.count ?? 0;
}

/**
 * Single read + single write covering both the quota check and the increment
 * (was two separate reads + a write across two functions). Still not atomic —
 * two concurrent calls can both read the same count before either writes, so a
 * true hard cap needs a Postgres upsert-with-increment RPC — but this halves the
 * round trips and narrows the race window versus checking and bumping separately.
 */
export async function checkAndBumpUsage(
	admin: SupabaseClient<Database>,
	userId: string,
	monthlyLimit: number,
): Promise<{ allowed: boolean; count: number }> {
	const period = firstOfMonth();
	const { data: existing } = await admin
		.from("usage")
		.select("count")
		.eq("user_id", userId)
		.eq("period", period)
		.maybeSingle();

	const currentCount = existing?.count ?? 0;
	if (currentCount >= monthlyLimit) {
		return { allowed: false, count: currentCount };
	}

	if (existing) {
		await admin
			.from("usage")
			.update({ count: currentCount + 1 })
			.eq("user_id", userId)
			.eq("period", period);
	} else {
		await admin.from("usage").insert({ user_id: userId, period, count: 1 });
	}
	return { allowed: true, count: currentCount + 1 };
}
