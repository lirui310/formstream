import type { Submission } from "./database.types";

// Submission field values come from anonymous public form submitters. Without this,
// a value like `=HYPERLINK(...)` opens as a live formula in Excel/Sheets for whoever
// exports — prefixing a leading =/+/-/@ with a tab neutralizes it while staying invisible.
function neutralizeFormula(str: string): string {
	return /^[=+\-@]/.test(str) ? `\t${str}` : str;
}

function csvEscape(value: unknown): string {
	const str = neutralizeFormula(value === null || value === undefined ? "" : String(value));
	if (/[",\n]/.test(str)) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

/** Columns are the fixed submission fields plus the union of every `data` key seen, in first-seen order. */
export function submissionsToCsv(submissions: Submission[]): string {
	const dataKeys: string[] = [];
	const seen = new Set<string>();
	for (const s of submissions) {
		for (const key of Object.keys(s.data)) {
			if (!seen.has(key)) {
				seen.add(key);
				dataKeys.push(key);
			}
		}
	}

	const headers = ["id", "created_at", "ip", "country", "is_spam", ...dataKeys];
	const lines = [headers.map(csvEscape).join(",")];

	for (const s of submissions) {
		const row = [
			s.id,
			s.created_at,
			s.ip ?? "",
			s.country ?? "",
			s.is_spam ? "true" : "false",
			...dataKeys.map((k) => s.data[k] ?? ""),
		];
		lines.push(row.map(csvEscape).join(","));
	}

	return lines.join("\r\n");
}
