/**
 * Only allow same-app relative paths for post-submission redirects. Rejects absolute
 * URLs, protocol-relative URLs ("//evil.com"), and backslash variants browsers also
 * treat as protocol-relative — closes the open-redirect hole where `_redirect` (visitor
 * controlled) or `redirect_url` (form-owner controlled) could point off-site.
 */
export function sanitizeRedirectPath(path: string | null | undefined): string | null {
	if (!path) return null;
	if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
	return path;
}
