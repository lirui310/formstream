export type Role = "user" | "admin";
export type ProfileStatus = "active" | "suspended";
export type Plan = "free" | "pro" | "business";
export type ChannelType = "dingtalk" | "feishu" | "wework" | "email" | "webhook";

export type Profile = {
	id: string;
	role: Role;
	status: ProfileStatus;
	plan: Plan;
	created_at: string;
};

export type Form = {
	id: string;
	user_id: string;
	name: string;
	access_key: string;
	allowed_domains: string[];
	is_active: boolean;
	turnstile_enabled: boolean;
	redirect_url: string | null;
	spam_protection: boolean;
	created_at: string;
	updated_at: string;
};

export type NotificationChannel = {
	id: string;
	form_id: string;
	type: ChannelType;
	config: Record<string, unknown>;
	is_active: boolean;
	created_at: string;
};

export type Submission = {
	id: string;
	form_id: string;
	data: Record<string, unknown>;
	files: Array<{ name: string; key: string; size: number; type: string }>;
	ip: string | null;
	user_agent: string | null;
	country: string | null;
	is_spam: boolean;
	created_at: string;
};

export type Usage = {
	user_id: string;
	period: string;
	count: number;
};

export type AuditLog = {
	id: string;
	actor_id: string | null;
	actor_email: string | null;
	action: string;
	target_type: string;
	target_id: string | null;
	detail: Record<string, unknown>;
	created_at: string;
};

// `interface` declarations don't get an implicit index signature inferred by TS,
// so they fail the `extends Record<string, unknown>` checks supabase-js's generics
// rely on — every shape below must be a `type` object literal, not an `interface`.
type WithNoRelationships = { Relationships: [] };

export type Database = {
	public: {
		Tables: {
			profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> } & WithNoRelationships;
			forms: { Row: Form; Insert: Partial<Form>; Update: Partial<Form> } & WithNoRelationships;
			notification_channels: {
				Row: NotificationChannel;
				Insert: Partial<NotificationChannel>;
				Update: Partial<NotificationChannel>;
			} & WithNoRelationships;
			submissions: {
				Row: Submission;
				Insert: Partial<Submission>;
				Update: Partial<Submission>;
			} & WithNoRelationships;
			usage: { Row: Usage; Insert: Partial<Usage>; Update: Partial<Usage> } & WithNoRelationships;
			audit_logs: { Row: AuditLog; Insert: Partial<AuditLog>; Update: Partial<AuditLog> } & WithNoRelationships;
		};
		Views: Record<string, never>;
		Functions: Record<string, never>;
	};
};
