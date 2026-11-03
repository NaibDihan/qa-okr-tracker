// Fills an EMPTY database with sample engineers, projects, entries and targets.
// Usage: npm run seed:demo        (add -- --force to wipe existing data first)
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(ROOT, "data");
const force = process.argv.includes("--force");
if (force) for (const f of ["okr.json", "okr.json.tmp"]) fs.rmSync(path.join(dataDir, f), { force: true });

const db = await import("../lib/db.js");
db.openDb(dataDir);

if (db.listEngineers().length) {
  console.log("Database already has data. Run `npm run seed:demo -- --force` to replace it with demo data.");
  process.exit(0);
}

const naib = db.createEngineer({ name: "A F M Naib Uddin", jiraAccountId: "demo-001" });
const nusrat = db.createEngineer({ name: "Nusrat Jahan", jiraAccountId: "demo-002" });
const tanvir = db.createEngineer({ name: "Tanvir Ahmed", jiraAccountId: "demo-003" });

db.createProject({ jiraKey: "KEY", name: "Keystone", engineerId: naib.id });
db.createProject({ jiraKey: "EMC", name: "EMC", engineerId: naib.id });
db.createProject({ jiraKey: "PAYRA", name: "Payra", engineerId: nusrat.id });
db.createProject({ jiraKey: "TT", name: "Tour Tempo", engineerId: nusrat.id });
db.createProject({ jiraKey: "CAB", name: "Caboodle", engineerId: tanvir.id });

const entries = {
  [naib.id]: {
    "2026-07": [210, 0, 8, 7, 1, 1], "2026-08": [265, 1, 5, 3, 2, 2], "2026-09": [240, 0, 3, 3, 4, 4], "2026-10": [190, 0, 4, 4, 2, 1],
  },
  [nusrat.id]: {
    "2026-07": [180, 1, 6, 6, 3, 2], "2026-08": [205, 0, 7, 7, 4, 3], "2026-09": [230, 0, 5, 5, 5, 4], "2026-10": [160, 1, 3, 2, 3, 2],
  },
  [tanvir.id]: {
    "2026-07": [150, 2, 4, 3, 2, 1], "2026-08": [170, 1, 4, 4, 2, 2], "2026-09": [140, 1, 6, 5, 1, 1],
  },
};
const fields = ["test_cases", "production_bugs", "releases", "signoffs", "scripts_added", "prs_merged"];
for (const [id, months] of Object.entries(entries)) {
  for (const [month, vals] of Object.entries(months)) {
    db.saveEntry(id, month, Object.fromEntries(fields.map((f, i) => [f, vals[i]])));
  }
}

db.saveComments(naib.id, "2026-08", { drr: "7 bug tickets are from Keystone project and 3 from EMC project", dde: "Keystone test cases executed" });
db.saveComments(naib.id, "2026-07", { otrs: "Sign-off provided for Payra (1), Tour Tempo (3), EMC (1), UU (2)" });
db.saveComments(naib.id, "2026-09", { scripts: "Quote Import Export module", prs: "Quote Import Export module" });
db.saveComments(nusrat.id, "2026-09", { cycle: "Two long-running payment tickets in Payra" });
db.saveComments(tanvir.id, "2026-08", { pdl: "One hotfix escaped on Caboodle checkout" });

const q3 = [
  { krKey: "drr", baseline: 0, target: 5 },
  { krKey: "dde", baseline: null, target: null, direction: "monitor" },
  { krKey: "pdl", baseline: 0, target: 4 },
  { krKey: "cycle", baseline: 0, target: 2.4 },
  { krKey: "otrs", baseline: 0, target: 100 },
  { krKey: "scripts", baseline: 0, target: 10 },
  { krKey: "prs", baseline: 1, target: 10 },
];
for (const e of [naib, nusrat, tanvir]) {
  db.saveTargets(e.id, "2026-Q3", q3);
  db.saveTargets(e.id, "2026-Q4", q3);
}

console.log("Demo data added: 3 engineers, 5 projects, Jul–Oct 2026 entries, Q3/Q4 targets.");
