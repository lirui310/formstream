export interface NotifyMessage {
	submissionId: string;
	formId: string;
	/** From the reserved `_subject` field on the submission, if provided. */
	subject?: string | null;
}
