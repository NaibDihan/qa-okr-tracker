// KR definitions and calculation engine.
import { fetchBugs, fetchCycleTickets, jiraMode } from "./jira.js";
import {
  getEngineer, projectsForEngineer, getEntries, getComments, getTargets,
} from "./db.js";

const QUALITY = "Improve the reliability and effectiveness of QA testing output";
const DELIVERY = "Ensure predictable, on-time QA delivery within sprints/releases";
const PROCESS = "Strengthen QA practices and grow team capability";

export const KRS = [
  {
    key: "drr", name: "Defect Rejection Rate", category: "Quality", objective: QUALITY,
    source: "Jira: Bugs with status Won’t Do ÷ Bugs reported", unit: "%", direction: "lower",
    rule: "max", ruleText: "On Track if ≤ target, otherwise At Risk",
    manualFields: [], formula: "Bugs rejected ÷ Bugs reported",
  },
  {
    key: "dde", name: "Defect Detection Efficiency", category: "Quality", objective: QUALITY,
    source: "Jira (valid bugs) ÷ Manual (test cases executed)", unit: "%", direction: "monitor",
    rule: "none", ruleText: "No target (trend only)",
    manualFields: ["test_cases"], formula: "(Bugs reported − Bugs rejected) ÷ Test cases executed",
  },
  {
    key: "pdl", name: "Production Defect Leakage Rate", category: "Quality", objective: QUALITY,
    source: "Manual (production bugs) ÷ Jira (bugs reported)", unit: "%", direction: "lower",
    rule: "max", ruleText: "On Track if ≤ target, otherwise At Risk",
    manualFields: ["production_bugs"], formula: "Production bugs ÷ Bugs reported",
  },
  {
    key: "cycle", name: "Average QA Cycle Time", category: "Delivery", objective: DELIVERY,
    source: "Jira status history (In QA → Closed)", unit: "hours", direction: "lower",
    rule: "max", ruleText: "On Track if ≤ target, otherwise At Risk",
    manualFields: [], formula: "Average hours from last entry into In QA to Closed",
  },
  {
    key: "otrs", name: "On-Time Release Sign-off Rate", category: "Delivery", objective: DELIVERY,
    source: "Manual (sign-offs ÷ releases)", unit: "%", direction: "higher",
    rule: "min", ruleText: "On Track if ≥ target, otherwise At Risk",
    manualFields: ["releases", "signoffs"], formula: "Sign-offs provided ÷ Releases done",
  },
  {
    key: "scripts", name: "Automated Test Scripts Added", category: "Process", objective: PROCESS,
    source: "Manual (Bitbucket later)", unit: "count", direction: "higher",
    rule: "exact", ruleText: "On Track if = target, Exceeded if more, At Risk if less",
    manualFields: ["scripts_added"], formula: "Sum of scripts added",
  },
  {
    key: "prs", name: "PR Merged (Automation)", category: "Process", objective: PROCESS,
    source: "Manual (Bitbucket later)", unit: "count", direction: "higher",
    rule: "exact", ruleText: "On Track if = target, Exceeded if more, At Risk if less",
    manualFields: ["prs_merged"], formula: "Sum of PRs merged",
  },
];

export const KR_BY_KEY = Object.fromEntries(KRS.map((k) => [k.key, k]));

export const DIRECTION_LABEL = { higher: "Higher Better", lower: "Lower Better", monitor: "Monitor" };

export function formatValue(kr, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (kr.unit === "%") return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
  if (kr.unit === "hours") return `${v.toFixed(2)} h`;
  return String(Math.round(v * 100) / 100);
}

// ---------- Raw numbers ----------
const emptyRaw = () => ({
  bugsReported: 0, bugsRejected: 0, cycleHours: [],
  test_cases: null, production_bugs: null, releases: null, signoffs: null, scripts_added: null, prs_merged: null,
});

const addNullable = (a, b) => (a === null && b === null ? null : (a || 0) + (b || 0));

export function mergeRaw(list) {
  const out = emptyRaw();
  for (const r of list) {
    out.bugsReported += r.bugsReported;
    out.bugsRejected += r.bugsRejected;
    out.cycleHours = out.cycleHours.concat(r.cycleHours);
    for (const f of ["test_cases", "production_bugs", "releases", "signoffs", "scripts_added", "prs_merged"]) {
      out[f] = addNullable(out[f], r[f]);
    }
  }
  return out;
}

export function krValue(key, r) {
  switch (key) {
    case "drr": return r.bugsReported > 0 ? (r.bugsRejected / r.bugsReported) * 100 : null;
    case "dde": return r.test_cases > 0 ? ((r.bugsReported - r.bugsRejected) / r.test_cases) * 100 : null;
    case "pdl": return r.production_bugs !== null && r.bugsReported > 0 ? (r.production_bugs / r.bugsReported) * 100 : null;
    case "cycle": return r.cycleHours.length ? r.cycleHours.reduce((a, b) => a + b, 0) / r.cycleHours.length : null;
    case "otrs": return r.releases > 0 && r.signoffs !== null ? (r.signoffs / r.releases) * 100 : null;
    case "scripts": return r.scripts_added;
    case "prs": return r.prs_merged;
    default: return null;
  }
}

// The raw inputs behind a value, shown as "4 / 50" style hints.
export function krInputs(key, r) {
  const n = (v) => (v === null ? "—" : v);
  switch (key) {
    case "drr": return `${r.bugsRejected} rejected / ${r.bugsReported} reported`;
    case "dde": return `${r.bugsReported - r.bugsRejected} valid bugs / ${n(r.test_cases)} test cases`;
    case "pdl": return `${n(r.production_bugs)} prod bugs / ${r.bugsReported} reported`;
    case "cycle": return `${r.cycleHours.length} tickets`;
    case "otrs": return `${n(r.signoffs)} sign-offs / ${n(r.releases)} releases`;
    default: return "";
  }
}

// ---------- Status ----------
const round2 = (v) => Math.round(v * 100) / 100;

export function evaluate({ kr, direction, target, value, period, missingMonths }) {
  // Targets are quarterly, so status is only given for a quarter view.
  if (period.mode !== "quarter") return { status: null, progress: null, note: "" };
  let progress = null;
  if (target !== null && value !== null && direction !== "monitor") {
    if (direction === "higher") progress = target > 0 ? value / target : null;
    else progress = value > 0 ? target / value : null;
  }
  if (kr.rule === "none") return { status: "trend", progress: null, note: "Trend only" };
  if (target === null || target === undefined) return { status: "none", progress, note: "No target set" };
  if (!period.complete) return { status: "pending", progress, note: "Quarter in progress" };
  if (missingMonths.length) return { status: "pending", progress, note: `Missing entries: ${missingMonths.join(", ")}` };
  if (value === null) return { status: "pending", progress, note: "No data" };
  // Compare at display precision so 4.96% vs a 5% target isn't decided by float noise.
  const v = round2(value), t = round2(target);
  let status;
  if (kr.rule === "max") status = v <= t ? "on-track" : "at-risk";        // DRR, PDL, Cycle time
  else if (kr.rule === "min") status = v >= t ? "on-track" : "at-risk";   // Sign-off rate
  else status = v === t ? "on-track" : v > t ? "exceeded" : "at-risk";    // Scripts, PRs
  return { status, progress, note: "" };
}

export const STATUS_LABEL = {
  "exceeded": "Exceeded", "on-track": "On Track", "at-risk": "At Risk",
  "pending": "Pending", "trend": "Trend only", "none": "No target",
};

// ---------- Engineer computation ----------
export async function computeEngineer(engineerId, period, { refresh = false } = {}) {
  const engineer = getEngineer(engineerId);
  if (!engineer) throw new Error("Engineer not found");
  const projects = projectsForEngineer(engineerId);
  const projectKeys = projects.map((p) => p.jiraKey);
  const monthKeys = period.months.map((m) => m.key);
  const warnings = [];

  if (!projectKeys.length) warnings.push("No Jira projects are assigned to this engineer (Setup → Projects).");

  let bugs = [], cycle = [], jiraError = null;
  try {
    [bugs, cycle] = await Promise.all([
      fetchBugs({ engineer, projectKeys, start: period.start, end: period.end, refresh }),
      fetchCycleTickets({ engineer, projectKeys, start: period.start, end: period.end, refresh }),
    ]);
  } catch (e) {
    jiraError = e.message;
    warnings.push(`Jira data unavailable: ${e.message}`);
  }

  const entries = getEntries(engineerId, monthKeys);
  const comments = getComments(engineerId, monthKeys);
  const targets = period.quarterKey ? getTargets(engineerId, period.quarterKey) : {};

  // Per-month raw buckets
  const months = {};
  for (const m of monthKeys) {
    const r = emptyRaw();
    const e = entries[m];
    if (e) for (const f of ["test_cases", "production_bugs", "releases", "signoffs", "scripts_added", "prs_merged"]) r[f] = e[f];
    months[m] = r;
  }
  for (const b of bugs) {
    const m = String(b.created).slice(0, 7);
    if (!months[m]) continue;
    months[m].bugsReported++;
    if (b.rejected) months[m].bugsRejected++;
  }
  for (const t of cycle) {
    const m = String(t.closedAt).slice(0, 7);
    if (months[m]) months[m].cycleHours.push(t.hours);
  }
  const total = mergeRaw(Object.values(months));

  const rows = KRS.map((kr) => {
    const t = targets[kr.key] || {};
    const direction = kr.direction; // fixed per KR
    const target = t.target ?? null;
    const baseline = t.baseline ?? null;
    const missingMonths = period.months
      .filter((m) => kr.manualFields.some((f) => months[m.key][f] === null))
      .map((m) => m.label.split(" ")[0]);
    const jiraBased = ["drr", "dde", "pdl", "cycle"].includes(kr.key);
    const value = jiraError && jiraBased ? null : krValue(kr.key, total);
    const ev = evaluate({ kr, direction, target, value, period, missingMonths });
    return {
      key: kr.key,
      name: kr.name,
      category: kr.category,
      objective: kr.objective,
      source: kr.source,
      unit: kr.unit,
      formula: kr.formula,
      rule: kr.rule,
      ruleText: kr.ruleText,
      direction,
      baseline,
      target,
      months: period.months.map((m) => {
        const v = jiraError && jiraBased ? null : krValue(kr.key, months[m.key]);
        return { month: m.key, value: v, display: formatValue(kr, v), inputs: krInputs(kr.key, months[m.key]) };
      }),
      total: { value, display: formatValue(kr, value), inputs: krInputs(kr.key, total) },
      progress: ev.progress,
      status: ev.status,
      statusNote: ev.note,
      missingMonths,
      comments: comments
        .filter((c) => c.krKey === kr.key)
        .map((c) => ({ month: c.month, label: period.months.find((m) => m.key === c.month)?.label || c.month, text: c.text })),
    };
  });

  return {
    engineer,
    projects: projectKeys,
    period,
    jiraMode: jiraMode(),
    warnings,
    entriesFound: monthKeys.filter((m) => entries[m]),
    raw: { months, total },
    rows,
    details: {
      bugs: bugs.map((b) => ({ key: b.key, created: String(b.created).slice(0, 10), status: b.status, rejected: b.rejected })),
      cycle: cycle.map((c) => ({ key: c.key, closed: String(c.closedAt).slice(0, 10), hours: Math.round(c.hours * 100) / 100 })),
    },
  };
}

// ---------- Team aggregate ----------
// Rates are recomputed from the combined raw numbers, never averaged.
export function computeTeam(results, period) {
  const months = {};
  for (const m of period.months) months[m.key] = mergeRaw(results.map((r) => r.raw.months[m.key]));
  const total = mergeRaw(Object.values(months));
  return {
    period,
    raw: { months, total },
    rows: KRS.map((kr) => {
      const value = krValue(kr.key, total);
      return {
        key: kr.key, name: kr.name, category: kr.category, unit: kr.unit, direction: kr.direction,
        months: period.months.map((m) => {
          const v = krValue(kr.key, months[m.key]);
          return { month: m.key, value: v, display: formatValue(kr, v) };
        }),
        total: { value, display: formatValue(kr, value), inputs: krInputs(kr.key, total) },
        perEngineer: results.map((r) => {
          const row = r.rows.find((x) => x.key === kr.key);
          return { engineerId: r.engineer.id, value: row.total.value, display: row.total.display, status: row.status };
        }),
      };
    }),
  };
}
