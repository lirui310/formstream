import { Hono } from "hono";
import { publicApp } from "./public";
import { formsApp } from "./forms";
import { adminApp } from "./admin";

const app = new Hono<{ Bindings: Env }>();

app.route("/s", publicApp);
app.route("/api", formsApp);
app.route("/api/admin", adminApp);

app.notFound((c) => c.json({ success: false, code: "NOT_FOUND", message: "no such route" }, 404));

export default app;
