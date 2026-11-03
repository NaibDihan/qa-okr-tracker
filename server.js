// QA OKR Tracker: zero-dependency Node.js server.
// Run: node server.js   (Node 18.17 or newer)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(ROOT);

const db = await import("./lib/db.js");
const { parsePeriod, quarterOfMonth, previousQuarter } = await import("./lib/period.js");
const jira = await import("./lib/jira.js");
const { KRS, DIRECTION_LABEL, STATUS_LABEL, computeEngineer, computeTeam } = await import("./lib/krs.js");
const { buildXlsxReport, buildPdfReport } = await import("./lib/report-export.js");

db.openDb(path.join(ROOT, "data"));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

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
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
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

// ---------- Routes ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler });
};

route("GET", "/api/meta", () => ({
  krs: KRS,
  directionLabels: DIRECTION_LABEL,
  statusLabels: STATUS_LABEL,
  jira: jira.jiraInfo(),
}));

// Engineers
route("GET", "/api/engineers", () => db.listEngineers());
route("POST", "/api/engineers", ({ body }) => {
  if (jira.jiraMode() === "live" && !body.jiraAccountId) {
    throw Object.assign(new Error("Pick the engineer from the Jira list so their account is linked"), { status: 400 });
  }
  return { engineer: db.createEngineer(body) };
});
route("PUT", "/api/engineers/:id", ({ params, body }) => db.updateEngineer(params.id, body));
route("DELETE", "/api/engineers/:id", ({ params }) => { db.deleteEngineer(params.id); return { ok: true }; });

// Projects
route("GET", "/api/projects", () => db.listProjects());
route("POST", "/api/projects", ({ body }) => db.createProject(body));
// Assign a Jira project to an engineer (creates it, or moves it from another engineer).
route("PUT", "/api/projects/assign", ({ body }) => db.assignProject(body));
route("PUT", "/api/projects/:id", ({ params, body }) => db.updateProject(params.id, body));
route("DELETE", "/api/projects/:id", ({ params }) => { db.deleteProject(params.id); return { ok: true }; });

// Manual entries + comments
route("GET", "/api/entry", ({ q }) => {
  const id = Number(q.get("engineerId"));
  const month = q.get("month");
  return {
    entry: db.getEntries(id, [month])[month] || null,
    comments: Object.fromEntries(db.getComments(id, [month]).map((c) => [c.krKey, c.text])),
    enteredMonths: db.entryMonthsForEngineer(id),
  };
});
route("PUT", "/api/entry", ({ body }) => {
  const { engineerId, month, values, comments } = body;
  if (!engineerId || !/^\d{4}-\d{2}$/.test(month || "")) throw Object.assign(new Error("Engineer and month are required"), { status: 400 });
  db.saveEntry(engineerId, month, values || {});
  db.saveComments(engineerId, month, comments || {});
  return { ok: true, quarter: quarterOfMonth(month) };
});

// Targets
route("GET", "/api/targets", ({ q }) => db.getTargets(Number(q.get("engineerId")), q.get("quarter")));
route("GET", "/api/targets/previous", ({ q }) => db.getTargets(Number(q.get("engineerId")), previousQuarter(q.get("quarter"))));
route("PUT", "/api/targets", ({ body }) => {
  if (!body.engineerId || !/^\d{4}-Q[1-4]$/.test(body.quarter || "")) throw Object.assign(new Error("Engineer and quarter are required"), { status: 400 });
  db.saveTargets(body.engineerId, body.quarter, body.rows || []);
  return { ok: true };
});

// OKR results
route("GET", "/api/okr", async ({ q }) => computeEngineer(Number(q.get("engineerId")), periodFrom(q), { refresh: q.get("refresh") === "1" }));
route("GET", "/api/report", async ({ q }) => buildReport(q));
route("GET", "/api/report/export", async ({ q, res }) => {
  const report = await buildReport(q);
  const format = q.get("format");
  const base = `QA-OKR-${report.period.label.replace(/[^\w-]+/g, "-")}`;
  if (format === "xlsx") {
    const buf = buildXlsxReport(report);
    send(res, 200, buf, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${base}.xlsx"`,
    });
  } else if (format === "pdf") {
    const buf = buildPdfReport(report);
    send(res, 200, buf, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${base}.pdf"` });
  } else {
    throw Object.assign(new Error("format must be xlsx or pdf"), { status: 400 });
  }
  return undefined;
});

// Jira
route("POST", "/api/jira/test", async () => jira.testConnection());
route("GET", "/api/jira/users", async ({ q }) => jira.listJiraUsers({ refresh: q.get("refresh") === "1" }));
route("GET", "/api/jira/projects", async ({ q }) => jira.listJiraProjects({ refresh: q.get("refresh") === "1" }));

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
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
    const status = e.status && e.status < 500 ? e.status : e.status ? 502 : 400;
    if (!res.headersSent) send(res, status, { error: e.message });
    if (!e.status) console.error(e);
  }
});

server.listen(PORT, () => {
  console.log(`\n  QA OKR Tracker running at http://localhost:${PORT}`);
  console.log(`  Jira mode: ${jira.jiraMode() === "live" ? `LIVE (${process.env.JIRA_BASE_URL})` : "DEMO (set Jira credentials in .env to connect)"}\n`);
});
