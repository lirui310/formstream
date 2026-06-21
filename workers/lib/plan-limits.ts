import type { Plan } from "./database.types";

/** Max bytes per uploaded file by plan; `null` means uploads aren't available at all (docs §11.4). */
export const PLAN_FILE_LIMITS: Record<Plan, number | null> = {
	free: null,
	pro: 10 * 1024 * 1024,
	business: 25 * 1024 * 1024,
};

/** Max forms per account; `null` means unlimited. */
export const PLAN_FORM_LIMITS: Record<Plan, number | null> = {
	free: 3,
	pro: null,
	business: null,
};

/** Max active notification channels per form; `null` means unlimited. */
export const PLAN_CHANNEL_LIMITS: Record<Plan, number | null> = {
	free: 1,
	pro: 5,
	business: null,
};

/** Max non-spam submissions per calendar month, account-wide. */
export const PLAN_SUBMISSION_LIMITS: Record<Plan, number> = {
	free: 250,
	pro: 5000,
	business: 50000,
};
