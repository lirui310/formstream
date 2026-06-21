import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("login", "routes/login.tsx"),
	route("register", "routes/register.tsx"),
	route("logout", "routes/logout.tsx"),
	layout("routes/dashboard/layout.tsx", [
		route("dashboard", "routes/dashboard/index.tsx"),
		route("dashboard/new", "routes/dashboard/new.tsx"),
		route("dashboard/forms/:id", "routes/dashboard/form-detail.tsx"),
		route("dashboard/forms/:id/export", "routes/dashboard/export-csv.tsx"),
		route("dashboard/submissions/:id/files/:idx", "routes/dashboard/file-download.tsx"),
		route("dashboard/usage", "routes/dashboard/usage.tsx"),
		layout("routes/admin/layout.tsx", [
			route("admin", "routes/admin/index.tsx"),
			route("admin/users", "routes/admin/users.tsx"),
			route("admin/forms", "routes/admin/forms.tsx"),
			route("admin/logs", "routes/admin/logs.tsx"),
		]),
	]),
] satisfies RouteConfig;
