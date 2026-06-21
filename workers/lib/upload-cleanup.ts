import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const QUERY_PAGE_SIZE = 1000;
const R2_DELETE_BATCH_SIZE = 1000;

function addFileKeys(keys: Set<string>, rows: Array<{ files: Array<{ key: string }> }>) {
	for (const row of rows) {
		for (const file of row.files) {
			if (file.key) keys.add(file.key);
		}
	}
}

export async function deleteUploadKeys(bucket: R2Bucket, keys: Iterable<string>): Promise<void> {
	const uniqueKeys = [...new Set(keys)];
	for (let index = 0; index < uniqueKeys.length; index += R2_DELETE_BATCH_SIZE) {
		await bucket.delete(uniqueKeys.slice(index, index + R2_DELETE_BATCH_SIZE));
	}
}

export async function deleteSubmissionUploads(
	bucket: R2Bucket,
	supabase: SupabaseClient<Database>,
	submissionId: string,
): Promise<boolean> {
	const { data: submission, error } = await supabase
		.from("submissions")
		.select("files")
		.eq("id", submissionId)
		.maybeSingle();
	if (error) throw new Error(`failed to load submission uploads: ${error.message}`);
	if (!submission) return false;

	await deleteUploadKeys(
		bucket,
		submission.files.map((file) => file.key),
	);
	return true;
}

export async function deleteFormUploads(
	bucket: R2Bucket,
	supabase: SupabaseClient<Database>,
	formId: string,
): Promise<void> {
	const keys = new Set<string>();
	for (let from = 0; ; from += QUERY_PAGE_SIZE) {
		const { data: submissions, error } = await supabase
			.from("submissions")
			.select("files")
			.eq("form_id", formId)
			.order("id", { ascending: true })
			.range(from, from + QUERY_PAGE_SIZE - 1);
		if (error) throw new Error(`failed to load form uploads: ${error.message}`);

		addFileKeys(keys, submissions ?? []);
		if (!submissions || submissions.length < QUERY_PAGE_SIZE) break;
	}

	await deleteUploadKeys(bucket, keys);
}

export async function deleteUserUploads(
	bucket: R2Bucket,
	supabase: SupabaseClient<Database>,
	userId: string,
): Promise<void> {
	for (let from = 0; ; from += QUERY_PAGE_SIZE) {
		const { data: forms, error } = await supabase
			.from("forms")
			.select("id")
			.eq("user_id", userId)
			.order("id", { ascending: true })
			.range(from, from + QUERY_PAGE_SIZE - 1);
		if (error) throw new Error(`failed to load user forms: ${error.message}`);

		for (const form of forms ?? []) {
			await deleteFormUploads(bucket, supabase, form.id);
		}
		if (!forms || forms.length < QUERY_PAGE_SIZE) break;
	}
}
