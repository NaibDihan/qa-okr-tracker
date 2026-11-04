// The whole app as one request handler: handle(req, res).
// Used by server.js (local `npm start`) and api/index.js (Vercel).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import * as db from "./db.js";
import { parsePeriod, quarterOfMonth, previousQuarter } from "./period.js";
import * as jira from "./jira.js";
import { KRS, DIRECTION_LABEL, STATUS_LABEL, computeEngineer, computeTeam } from "./krs.js";
import { buildXlsxReport, buildPdfReport } from "./report-export.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let ready = false;
function init() {
  if (ready) return;
  db.openDb(path.join(ROOT, "data"));
  ready = true;
}

// ---------- Helpers ----------
function send(res, status, data, headers = {}) {
  const body = typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": typeof data === "object" && !Buffer.isBuffer(data) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

async function readBody(req) {
  let text;
  // On Vercel the runtime has usually read and parsed the body already.
  let preparsed;
  try { preparsed = req.body; } catch { throw Object.assign(new Error("Invalid JSON body"), { status: 400 }); }
  if (preparsed !== undefined && preparsed !== null) {
    if (typeof preparsed === "object" && !Buffer.isBuffer(preparsed)) return preparsed;
    text = Buffer.isBuffer(preparsed) ? preparsed.toString("utf8") : String(preparsed);
  } else {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("Invalid JSON body"), { status: 400 }); }
}

function periodFrom(q) {
  return parsePeriod({ mode: q.get("mode"), value: q.get("value"), from: q.get("from"), to: q.get("to") });
}

async function buildReport(q) {
  const period = periodFrom(q);
  const ids = (q.get("engineerIds") || "").split(",").map(Number).filter(Boolean);
  if (!ids.length) throw Object.assign(new Error("Pick at least one QA engineer"), { status: 400 });
  const refresh = q.get("refresh") === "1";
  const engineers = [];
  for (const id of ids) engineers.push(await computeEngineer(id, period, { refresh }));
  const team = ids.length > 1 ? computeTeam(engineers, period) : null;
  return { period, generatedAt: new Date().toISOString(), engineers, team, jiraMode: jira.jiraMode() };
}

// ---------- Optional password (set APP_PASSWORD to turn it on) ----------
const COOKIE = "okr_auth";
const passwordOn = () => !!process.env.APP_PASSWORD;
const sessionToken = () => crypto.createHmac("sha256", process.env.APP_PASSWORD).update("qa-okr-tracker-session").digest("hex");

function isAuthed(req) {
  if (!passwordOn()) return true;
  const cookies = Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
  }));
  const got = Buffer.from(cookies[COOKIE] || "");
  const want = Buffer.from(sessionToken());
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function authCookie(req, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" || process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------- Routes ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler });
};

route("POST", "/api/login", ({ body, req, res }) => {
  if (!passwordOn()) return { ok: true };
  const a = Buffer.from(String(body.password || ""));
  const b = Buffer.from(process.env.APP_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error("Wrong password"), { status: 401, auth: true });
  send(res, 200, { ok: true }, { "Set-Cookie": authCookie(req, sessionToken(), 60 * 60 * 24 * 30) });
  return undefined;
});
route("POST", "/api/logout", ({ req, res }) => {
  send(res, 200, { ok: true }, { "Set-Cookie": authCookie(req, "", 0) });
  return undefined;
});

route("GET", "/api/meta", () => ({
  krs: KRS,
  directionLabels: DIRECTION_LABEL,
  statusLabels: STATUS_LABEL,
  jira: jira.jiraInfo(),
  storage: db.storeInfo(),
  passwordOn: passwordOn(),
}));

// Engineers
route("GET", "/api/engineers", () => db.listEngineers());
route("POST", "/api/engineers", async ({ body }) => {
  if (jira.jiraMode() === "live" && !body.jiraAccountId) {
    throw Object.assign(new Error("Pick the engineer from the Jira list so their account is linked"), { status: 400 });
  }
  return { engineer: await db.createEngineer(body) };
});
route("PUT", "/api/engineers/:id", ({ params, body }) => db.updateEngineer(params.id, body));
route("DELETE", "/api/engineers/:id", async ({ params }) => { await db.deleteEngineer(params.id); return { ok: true }; });

// Projects
// Each project comes back with its site filled in (older records: the default site).
route("GET", "/api/projects", async () => (await db.listProjects()).map((p) => ({ ...p, site: jira.projectSite(p) })));
route("POST", "/api/projects", ({ body }) => db.createProject(body, { defaultSite: jira.defaultSite() }));
route("PUT", "/api/projects/assign", ({ body }) => db.assignProject(body, { defaultSite: jira.defaultSite() }));
route("PUT", "/api/projects/:id", ({ params, body }) => db.updateProject(params.id, body));
route("DELETE", "/api/projects/:id", async ({ params }) => { await db.deleteProject(params.id); return { ok: true }; });

// Manual entries + comments
route("GET", "/api/entry", async ({ q }) => {
  const id = Number(q.get("engineerId"));
  const month = q.get("month");
  const [entries, comments, enteredMonths] = await Promise.all([
    db.getEntries(id, [month]), db.getComments(id, [month]), db.entryMonthsForEngineer(id),
  ]);
  return {
    entry: entries[month] || null,
    comments: Object.fromEntries(comments.map((c) => [c.krKey, c.text])),
    enteredMonths,
  };
});
route("PUT", "/api/entry", async ({ body }) => {
  const { engineerId, month, values, comments } = body;
  if (!engineerId || !/^\d{4}-\d{2}$/.test(month || "")) throw Object.assign(new Error("Engineer and month are required"), { status: 400 });
  await db.saveEntry(engineerId, month, values || {});
  await db.saveComments(engineerId, month, comments || {});
  return { ok: true, quarter: quarterOfMonth(month) };
});

// Targets
route("GET", "/api/targets", ({ q }) => db.getTargets(Number(q.get("engineerId")), q.get("quarter")));
route("GET", "/api/targets/previous", ({ q }) => db.getTargets(Number(q.get("engineerId")), previousQuarter(q.get("quarter"))));
route("PUT", "/api/targets", async ({ body }) => {
  if (!body.engineerId || !/^\d{4}-Q[1-4]$/.test(body.quarter || "")) throw Object.assign(new Error("Engineer and quarter are required"), { status: 400 });
  await db.saveTargets(body.engineerId, body.quarter, body.rows || []);
  return { ok: true };
});

// OKR results
route("GET", "/api/okr", ({ q }) => computeEngineer(Number(q.get("engineerId")), periodFrom(q), { refresh: q.get("refresh") === "1" }));
route("GET", "/api/report", ({ q }) => buildReport(q));
route("GET", "/api/report/export", async ({ q, res }) => {
  const report = await buildReport(q);
  const format = q.get("format");
  const base = `QA-OKR-${report.period.label.replace(/[^\w-]+/g, "-")}`;
  if (format === "xlsx") {
    send(res, 200, buildXlsxReport(report), {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${base}.xlsx"`,
    });
  } else if (format === "pdf") {
    send(res, 200, buildPdfReport(report), { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${base}.pdf"` });
  } else {
    throw Object.assign(new Error("format must be xlsx or pdf"), { status: 400 });
  }
  return undefined;
});

// Jira
route("POST", "/api/jira/test", () => jira.testConnection());
route("GET", "/api/jira/users", ({ q }) => jira.listJiraUsers({ refresh: q.get("refresh") === "1" }));
route("GET", "/api/jira/projects", ({ q }) => jira.listJiraProjects({ refresh: q.get("refresh") === "1" }));

// ---------- Handler ----------
export async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    init();
    if (url.pathname.startsWith("/api/")) {
      const open = url.pathname === "/api/login" || url.pathname === "/api/logout";
      if (!open && !isAuthed(req)) return send(res, 401, { error: "Password required", auth: true });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
        const result = await r.handler({ params, body, q: url.searchParams, req, res });
        if (result !== undefined && !res.headersSent) send(res, 200, result);
        return;
      }
      return send(res, 404, { error: "Not found" });
    }

    // Static files (single-page app: unknown paths serve index.html)
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    // Jira's own errors (even its 401/403) go to the browser as 502, so they're never
    // mistaken for this app's password check.
    const status = e.upstream ? 502 : e.status || 400;
    if (!res.headersSent) send(res, status, { error: e.message, ...(e.auth ? { auth: true } : {}) });
    if (!e.status) console.error(e);
  }
}
