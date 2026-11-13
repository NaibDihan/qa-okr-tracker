// Explains, step by step, how Average QA Cycle Time is found for one engineer and month.
// Usage:  npm run diagnose:cycle -- "Naib" 2026-11
// Prints project keys, ticket keys and status names only (never tokens).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../lib/env.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(ROOT);

const [nameArg = "", month = ""] = process.argv.slice(2);
if (!nameArg || !/^\d{4}-\d{2}$/.test(month)) {
  console.log('Usage: npm run diagnose:cycle -- "<part of engineer name>" <YYYY-MM>');
  process.exit(1);
}

const db = await import("../lib/db.js");
const jira = await import("../lib/jira.js");
const { parsePeriod } = await import("../lib/period.js");
const { jiraFetch, searchAll, statusHistories, normStatus } = jira._diagnostics;
db.openDb(path.join(ROOT, "data"));

const line = (s = "") => console.log(s);
const info = jira.jiraInfo();
line(`Jira mode: ${info.mode} · sites: ${info.sites.map((s) => s.label).join(", ") || "none"}`);
line(`Default QA statuses: "${info.statuses.inQa}" → "${info.statuses.closed}" (projects can override in Setup)`);
if (info.mode !== "live") { line("Jira isn't configured, so there's nothing to check."); process.exit(0); }

const eng = (await db.listEngineers()).find((e) => e.name.toLowerCase().includes(nameArg.toLowerCase()));
if (!eng) { line(`No engineer matching "${nameArg}".`); process.exit(1); }
const period = parsePeriod({ mode: "month", value: month });
const projects = await db.projectsForEngineer(eng.id);
line(`Engineer: ${eng.name} · period ${period.start} to ${period.end} (end excluded)`);
line(`Projects: ${projects.map((p) => `${p.jiraKey}@${jira.siteLabel(jira.projectSite(p))}`).join(", ") || "none"}`);

// Group by site and by each project's QA statuses (defaults: In QA -> Closed).
const groups = new Map();
for (const p of projects) {
  const site = jira.projectSite(p);
  const flow = jira.projectFlow(p);
  const k = `${site}|${flow.qaStart}|${flow.qaDone}`;
  if (!groups.has(k)) groups.set(k, { site, flow, keys: [] });
  groups.get(k).keys.push(p.jiraKey);
}
const q = (keys) => keys.map((k) => `"${k}"`).join(", ");

for (const { site, flow, keys } of groups.values()) {
  const label = jira.siteLabel(site);
  const st = { inQa: flow.qaStart, closed: flow.qaDone };
  const inQa = normStatus(st.inQa), closed = normStatus(st.closed);
  line();
  line(`================ ${label}: ${keys.join(", ")} · QA "${st.inQa}" → "${st.closed}" ================`);
  const count = async (title, jql) => {
    try {
      const issues = await searchAll(site, jql, ["key"]);
      line(`${title}: ${issues.length}${issues.length ? "  e.g. " + issues.slice(0, 8).map((i) => i.key || `id:${i.id}`).join(", ") : ""}`);
      return issues;
    } catch (e) {
      line(`${title}: ERROR ${e.message}`);
      return [];
    }
  };
  const during = `DURING ("${period.start}", "${period.end}")`;
  const changed = await count("A. Tickets whose status changed at all in the month", `project in (${q(keys)}) AND status CHANGED ${during}`);
  const closedIssues = await count(`B. Tickets moved to "${st.closed}" in the month (what the app uses)`, `project in (${q(keys)}) AND status CHANGED TO "${st.closed}" ${during}`);
  await count(`C. Tickets moved from "${st.inQa}" to "${st.closed}" in the month`, `project in (${q(keys)}) AND status CHANGED FROM "${st.inQa}" TO "${st.closed}" ${during}`);
  if (!closedIssues.length) {
    if (!changed.length) continue;
    // Nothing reached "Closed": show which statuses these tickets really move through.
    try {
      const hist = await statusHistories(site, changed.slice(0, 100));
      const moves = new Map();
      for (const h of hist.values()) for (const ev of h) {
        if (String(ev.created).slice(0, 7) !== month) continue;
        const k = `${ev.from} → ${ev.to}`;
        moves.set(k, (moves.get(k) || 0) + 1);
      }
      line(`No ticket moved to "${st.closed}" here. Status changes in ${month} (most common first):`);
      for (const [k, n] of [...moves].sort((a, b) => b[1] - a[1]).slice(0, 20)) line(`      ${n} × ${k}`);
    } catch (e) {
      line(`Couldn't read status histories: ${e.message}`);
    }
    continue;
  }

  if (closedIssues[0] && !closedIssues[0].key) line("Note: Jira returned ticket IDs without keys (the app handles this).");

  let histories;
  try {
    histories = await statusHistories(site, closedIssues);
    line(`Status histories received for ${histories.size} of ${closedIssues.length} tickets.`);
  } catch (e) {
    line(`Status histories: ERROR ${e.message}`);
    continue;
  }

  const names = new Set();
  for (const h of histories.values()) for (const ev of h) { names.add(ev.from); names.add(ev.to); }
  line(`Status names seen in these tickets' histories: ${[...names].filter(Boolean).map((n) => `"${n}"`).join(", ")}`);

  line("Each ticket's status changes and the rule's decision (first 15 tickets):");
  for (const issue of closedIssues.slice(0, 15)) {
    const hist = histories.get(String(issue.id)) || [];
    const steps = hist.map((ev) => `${String(ev.created).slice(5, 16).replace("T", " ")} ${ev.from ?? "?"} → ${ev.to ?? "?"}`);
    const r = jira.qaCycleFromHistory(hist, period.start, period.end, flow);
    let why = "";
    if (!hist.length) why = "no status history received";
    else if (!r) {
      const last = [...hist].reverse().find((ev) => normStatus(ev.to) === closed);
      if (!last) why = `never moved to "${st.closed}" in the history`;
      else if (normStatus(last.from) !== inQa) why = `last move to "${st.closed}" came from "${last.from}", not "${st.inQa}"`;
      else why = "closed outside the month";
    }
    line(`  ${issue.key || "id:" + issue.id}: ${r ? `COUNTED, ${r.hours.toFixed(2)} h` : `not counted (${why})`}`);
    for (const s of steps.slice(-6)) line(`      ${s}`);
  }
}
line();
line("Done. Copy everything above and send it.");
