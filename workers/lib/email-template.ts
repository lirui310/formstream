import type { Form, Submission } from "./database.types";

function escapeHtml(input: string): string {
	const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	return input.replace(/[&<>"']/g, (c) => map[c]);
}

export function renderSubmissionEmail(form: Form, submission: Submission): string {
	const rows = Object.entries(submission.data)
		.map(
			([k, v]) =>
				`<tr><td style="padding:4px 8px;border:1px solid #ddd;"><b>${escapeHtml(k)}</b></td>` +
				`<td style="padding:4px 8px;border:1px solid #ddd;">${escapeHtml(String(v))}</td></tr>`,
		)
		.join("");

	return `
		<h2>新提交：${escapeHtml(form.name)}</h2>
		<table style="border-collapse:collapse;">${rows}</table>
		<p>时间：${escapeHtml(submission.created_at)}</p>
		<p>来源 IP：${escapeHtml(submission.ip ?? "-")}</p>
	`;
}
