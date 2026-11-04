// Jira Cloud client. Falls back to DEMO mode (generated data) when credentials are missing.

const cfg = () => ({
  baseUrl: (process.env.JIRA_BASE_URL || "").replace(/\/+$/, ""),
  email: process.env.JIRA_EMAIL || "",
  token: process.env.JIRA_API_TOKEN || "",
  bugType: process.env.JIRA_BUG_TYPE || "Bug",
  rejected: process.env.JIRA_STATUS_REJECTED || "Won’t Do",
  inQa: process.env.JIRA_STATUS_IN_QA || "In QA",
  closed: process.env.JIRA_STATUS_CLOSED || "Closed",
  cacheMs: Number(process.env.JIRA_CACHE_MINUTES || 10) * 60 * 1000,
});

export function jiraMode() {
  const c = cfg();
  return c.baseUrl && c.email && c.token ? "live" : "demo";
}

export function jiraInfo() {
  const c = cfg();
  return {
    mode: jiraMode(),
    baseUrl: c.baseUrl,
    email: c.email,
    statuses: { rejected: c.rejected, inQa: c.inQa, closed: c.closed },
    bugType: c.bugType,
  };
}

// Status names are compared loosely: case, spacing and apostrophe style don't matter.
export const normStatus = (s) =>
  String(s || "").toLowerCase().replace(/[‘’ʼ`´]/g, "'").replace(/\s+/g, " ").trim();

// Jira returns "2026-07-03T10:00:00.000+0600"; make it parseable everywhere.
const parseJiraDate = (s) => Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

// ---------- HTTP ----------
async function jiraFetch(pathname, { method = "GET", body } = {}) {
  const c = cfg();
  const auth = Buffer.from(`${c.email}:${c.token}`).toString("base64");
  const res = await fetch(c.baseUrl + pathname, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join("; ");
    } catch { /* ignore */ }
    const err = new Error(`Jira ${res.status} on ${pathname.split("?")[0]}${detail ? ": " + detail : ""}`);
    err.status = res.status;
    err.upstream = true; // a Jira error, not ours: reported to the browser as 502
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Enhanced JQL search (POST /rest/api/3/search/jql) with token pagination.
async function searchAll(jql, fields) {
  const issues = [];
  let nextPageToken;
  for (let guard = 0; guard < 200; guard++) {
    const page = await jiraFetch("/rest/api/3/search/jql", {
      method: "POST",
      body: { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
    });
    issues.push(...(page.issues || []));
    if (!page.nextPageToken || page.isLast) break;
    nextPageToken = page.nextPageToken;
  }
  return issues;
}

// Status-change history for many issues. Uses the bulk changelog API, falling back per issue.
async function statusHistories(issues) {
  const byId = new Map(issues.map((i) => [String(i.id), i.key]));
  const out = new Map(); // key -> [{created, from, to}]
  const push = (key, h) => {
    for (const it of h.items || []) {
      if (it.field !== "status") continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ created: h.created, from: it.fromString, to: it.toString });
    }
  };

  try {
    for (let i = 0; i < issues.length; i += 1000) {
      const chunk = issues.slice(i, i + 1000).map((x) => String(x.id));
      let nextPageToken;
      for (let guard = 0; guard < 500; guard++) {
        const page = await jiraFetch("/rest/api/3/changelog/bulkfetch", {
          method: "POST",
          body: { issueIdsOrKeys: chunk, fieldIds: ["status"], maxResults: 1000, ...(nextPageToken ? { nextPageToken } : {}) },
        });
        for (const log of page.issueChangeLogs || []) {
          const key = byId.get(String(log.issueId)) || String(log.issueId);
          for (const h of log.changeHistories || []) push(key, h);
        }
        if (!page.nextPageToken) break;
        nextPageToken = page.nextPageToken;
      }
    }
  } catch (e) {
    if (e.status && e.status !== 404 && e.status !== 405) throw e;
    // Bulk endpoint unavailable: fetch each issue's changelog (5 at a time).
    out.clear();
    const queue = [...issues];
    const worker = async () => {
      while (queue.length) {
        const issue = queue.shift();
        let startAt = 0;
        for (let guard = 0; guard < 50; guard++) {
          const page = await jiraFetch(`/rest/api/3/issue/${issue.key}/changelog?startAt=${startAt}&maxResults=100`);
          for (const h of page.values || []) push(issue.key, h);
          startAt += (page.values || []).length;
          if (page.isLast || !page.values?.length) break;
        }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
  }

  for (const list of out.values()) list.sort((a, b) => parseJiraDate(a.created) - parseJiraDate(b.created));
  return out;
}

/**
 * QA cycle rule: each move INTO "In QA" (re)starts the timer; any move to a status other
 * than Closed resets it; a ticket counts only when it goes "In QA" -> "Closed" directly.
 * Returns the last qualifying closure inside [start, end), or null.
 */
export function qaCycleFromHistory(history, start, end) {
  const c = cfg();
  const inQa = normStatus(c.inQa), closed = normStatus(c.closed);
  let qaStart = null;
  let result = null;
  for (const ev of history) {
    const to = normStatus(ev.to), from = normStatus(ev.from);
    if (to === inQa) {
      qaStart = ev.created;
    } else if (to === closed && from === inQa && qaStart) {
      const day = String(ev.created).slice(0, 10);
      if (day >= start && day < end) {
        result = {
          startedAt: qaStart,
          closedAt: ev.created,
          hours: (parseJiraDate(ev.created) - parseJiraDate(qaStart)) / 3_600_000,
        };
      }
      qaStart = null;
    } else {
      qaStart = null;
    }
  }
  return result;
}

const quoteList = (keys) => keys.map((k) => `"${k}"`).join(", ");

// ---------- Cache ----------
const cache = new Map();
async function cached(key, refresh, fn) {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < cfg().cacheMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---------- Public API ----------

export async function resolveAccountId(email) {
  if (jiraMode() !== "live") return "";
  const users = await jiraFetch(`/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
  const exact = users.find((u) => (u.emailAddress || "").toLowerCase() === email.toLowerCase());
  return (exact || users[0])?.accountId || "";
}

/**
 * Everyone in the Jira site (real people only, no apps or bots), sorted by name.
 * Needs the "Browse users and groups" global permission for the API account.
 */
export async function listJiraUsers({ refresh = false } = {}) {
  if (jiraMode() !== "live") return DEMO_USERS;
  return cached("users", refresh, async () => {
    const out = [];
    const size = 1000;
    for (let startAt = 0; startAt < 50000; startAt += size) {
      let page;
      try {
        page = await jiraFetch(`/rest/api/3/users/search?startAt=${startAt}&maxResults=${size}`);
      } catch (e) {
        if (e.status === 403) throw Object.assign(new Error("The Jira API account can't list users. Ask a Jira admin to give it the \"Browse users and groups\" global permission."), { status: 403, upstream: true });
        throw e;
      }
      for (const u of page) {
        if (u.accountType !== "atlassian" || u.active === false) continue;
        out.push({ accountId: u.accountId, name: u.displayName || "(no name)", email: u.emailAddress || "" });
      }
      if (page.length < size) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** All Jira projects the API account can see, sorted by key. */
export async function listJiraProjects({ refresh = false } = {}) {
  if (jiraMode() !== "live") return DEMO_PROJECTS;
  return cached("projects", refresh, async () => {
    const out = [];
    let startAt = 0;
    for (let guard = 0; guard < 200; guard++) {
      const page = await jiraFetch(`/rest/api/3/project/search?startAt=${startAt}&maxResults=100&orderBy=key`);
      for (const p of page.values || []) out.push({ key: p.key, name: p.name });
      startAt += (page.values || []).length;
      if (page.isLast || !(page.values || []).length) break;
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  });
}

const DEMO_USERS = [
  "A F M Naib Uddin", "Nusrat Jahan", "Tanvir Ahmed", "Farhana Akter", "Rakib Hasan", "Sadia Islam",
  "Mehedi Hasan", "Tasnim Rahman", "Arif Chowdhury", "Nabila Sultana", "Imran Hossain", "Shamima Nasrin",
  "Zahid Karim", "Lamia Haque", "Fahim Reza", "Rumana Afroz",
].map((name, i) => ({ accountId: `demo-${String(i + 1).padStart(3, "0")}`, name, email: "" }))
  .sort((a, b) => a.name.localeCompare(b.name));

const DEMO_PROJECTS = [
  ["CAB", "Caboodle"], ["EMC", "EMC"], ["HRM", "HR Manager"], ["KEY", "Keystone"], ["LMS", "Learning Hub"],
  ["PAYRA", "Payra"], ["POS", "Point of Sale"], ["TT", "Tour Tempo"], ["UU", "UU Portal"], ["WMS", "Warehouse"],
].map(([key, name]) => ({ key, name }));

export async function testConnection() {
  if (jiraMode() !== "live") return { ok: false, mode: "demo", message: "Jira isn't configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN), so the app is in demo mode." };
  const me = await jiraFetch("/rest/api/3/myself");
  return { ok: true, mode: "live", message: `Connected to ${cfg().baseUrl} as ${me.displayName}.` };
}

/**
 * Bugs reported by one engineer in the given projects, created in [start, end).
 * Returns [{ key, created, status, rejected }]
 */
export async function fetchBugs({ engineer, projectKeys, start, end, refresh }) {
  if (!projectKeys.length) return [];
  if (jiraMode() !== "live") return demoBugs(engineer, projectKeys, start, end);
  if (!engineer.jiraAccountId) throw new Error(`${engineer.name} has no Jira account linked (Setup → Engineers).`);
  const c = cfg();
  const jql = `project in (${quoteList(projectKeys)}) AND issuetype = "${c.bugType}" AND reporter = "${engineer.jiraAccountId}" AND created >= "${start}" AND created < "${end}" ORDER BY created ASC`;
  return cached(`bugs|${jql}`, refresh, async () => {
    const issues = await searchAll(jql, ["status", "created"]);
    const rej = normStatus(c.rejected);
    return issues.map((i) => ({
      key: i.key,
      created: i.fields.created,
      status: i.fields.status?.name || "",
      rejected: normStatus(i.fields.status?.name) === rej,
    }));
  });
}

/**
 * Tickets (any issue type) in the given projects that went "In QA" -> "Closed" in [start, end).
 * Returns [{ key, startedAt, closedAt, hours }]
 */
export async function fetchCycleTickets({ engineer, projectKeys, start, end, refresh }) {
  if (!projectKeys.length) return [];
  if (jiraMode() !== "live") return demoCycle(engineer, projectKeys, start, end);
  const c = cfg();
  const jql = `project in (${quoteList(projectKeys)}) AND status CHANGED TO "${c.closed}" DURING ("${start}", "${end}")`;
  return cached(`cycle|${jql}`, refresh, async () => {
    const issues = await searchAll(jql, ["summary"]);
    if (!issues.length) return [];
    const histories = await statusHistories(issues);
    const out = [];
    for (const issue of issues) {
      const r = qaCycleFromHistory(histories.get(issue.key) || [], start, end);
      if (r) out.push({ key: issue.key, ...r });
    }
    return out;
  });
}

// ---------- Demo data (deterministic) ----------
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* daysIn(start, end) {
  const d = new Date(start + "T00:00:00Z");
  const today = new Date().toISOString().slice(0, 10);
  while (true) {
    const s = d.toISOString().slice(0, 10);
    if (s >= end || s > today) return;
    yield s;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function demoBugs(engineer, projectKeys, start, end) {
  const out = [];
  for (const day of daysIn(start, end)) {
    for (const pk of projectKeys) {
      const r = rng(`bug|${engineer.id}|${pk}|${day}`);
      const n = r() < 0.38 ? 1 + Math.floor(r() * 2) : 0;
      for (let i = 0; i < n; i++) {
        const rejected = r() < 0.03;
        out.push({ key: `${pk}-${100 + Math.floor(r() * 900)}`, created: `${day}T10:00:00.000+0600`, status: rejected ? "Won’t Do" : "Closed", rejected });
      }
    }
  }
  return out;
}

function demoCycle(engineer, projectKeys, start, end) {
  const out = [];
  for (const day of daysIn(start, end)) {
    for (const pk of projectKeys) {
      const r = rng(`cyc|${engineer.id}|${pk}|${day}`);
      if (r() < 0.45) {
        const hours = Math.round((0.3 + r() * r() * 5) * 100) / 100;
        out.push({ key: `${pk}-${100 + Math.floor(r() * 900)}`, startedAt: `${day}T09:00:00.000+0600`, closedAt: `${day}T15:00:00.000+0600`, hours });
      }
    }
  }
  return out;
}
