// QA OKR Tracker: local server.
// Run: npm start   (Node 18.17 or newer)
// On Vercel, api/index.js is used instead; both share lib/app.js.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";

loadEnv(path.dirname(fileURLToPath(import.meta.url)));

const { handle } = await import("./lib/app.js");
const jira = await import("./lib/jira.js");
const db = await import("./lib/db.js");

const PORT = Number(process.env.PORT || 3000);

http.createServer(handle).listen(PORT, () => {
  db.openDb(path.join(path.dirname(fileURLToPath(import.meta.url)), "data"));
  const s = db.storeInfo();
  console.log(`\n  QA OKR Tracker running at http://localhost:${PORT}`);
  console.log(`  Jira mode: ${jira.jiraMode() === "live" ? `LIVE (${process.env.JIRA_BASE_URL})` : "DEMO (set Jira credentials in .env to connect)"}`);
  console.log(`  Storage:   ${s.kind === "redis" ? `Upstash Redis (${s.where})` : `local file (${s.where})`}`);
  console.log(`  Password:  ${process.env.APP_PASSWORD ? "on" : "off"}\n`);
});
