// Jira Cloud client. Falls back to DEMO mode (generated data) when credentials are missing.
//
// Several Jira sites are supported: list them in JIRA_BASE_URL separated by commas, e.g.
//   JIRA_BASE_URL=https://asthait.atlassian.net,https://emctech.atlassian.net
// One Atlassian account (JIRA_EMAIL + JIRA_API_TOKEN) is used for all of them, since an
// Atlassian API token works on every site that account can open. The first site is the
// default (projects saved before multi-site support belong to it).

const parseSites = () =>
  [...new Set((process.env.JIRA_BASE_URL || "").split(/[,\s]+/).map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean))];

const cfg = () => ({
  sites: parseSites(),
  baseUrl: parseSites()[0] || "",
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
  return c.sites.length && c.email && c.token ? "live" : "demo";
}

/** Short name for a site: "https://emctech.atlassian.net" -> "emctech". */
export const siteLabel = (url) => String(url || "").replace(/^https?:\/\//, "").split(".")[0] || "default";

export const defaultSite = () => cfg().sites[0] || "";
export const siteCount = () => cfg().sites.length;

/** The site a saved project belongs to (older records have none: the default site). */
export const projectSite = (p) => p.site || defaultSite();

export function jiraInfo() {
  const c = cfg();
  return {
    mode: jiraMode(),
    baseUrl: c.baseUrl,
    sites: c.sites.map((url) => ({ url, label: siteLabel(url) })),
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
async function jiraFetch(site, pathname, { method = "GET", body } = {}) {
  const c = cfg();
  const auth = Buffer.from(`${c.email}:${c.token}`).toString("base64");
  const res = await fetch(site + pathname, {
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
    const err = new Error(`Jira ${siteLabel(site)} ${res.status} on ${pathname.split("?")[0]}${detail ? ": " + detail : ""}`);
    err.status = res.status;
    err.upstream = true; // a Jira error, not ours: reported to the browser as 502
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Enhanced JQL search (POST /rest/api/3/search/jql) with token pagination.
async function searchAll(site, jql, fields) {
  const issues = [];
  let nextPageToken;
  for (let guard = 0; guard < 200; guard++) {
    const page = await jiraFetch(site, "/rest/api/3/search/jql", {
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
async function statusHistories(site, issues) {
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
        const page = await jiraFetch(site, "/rest/api/3/changelog/bulkfetch", {
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
          const page = await jiraFetch(site, `/rest/api/3/issue/${issue.key}/changelog?startAt=${startAt}&maxResults=100`);
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
  const users = await jiraFetch(defaultSite(), `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
  const exact = users.find((u) => (u.emailAddress || "").toLowerCase() === email.toLowerCase());
  return (exact || users[0])?.accountId || "";
}

// Runs fn(site) on every site; a site that fails is reported as a warning instead of
// breaking the whole list (a client's Jira may not allow everything).
async function eachSite(fn) {
  const sites = cfg().sites;
  const results = await Promise.allSettled(sites.map((site) => fn(site)));
  const ok = [], warnings = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push({ site: sites[i], value: r.value });
    else warnings.push(`${siteLabel(sites[i])}: ${r.reason?.message || r.reason}`);
  });
  if (!ok.length && warnings.length) throw Object.assign(new Error(warnings.join(" | ")), { upstream: true });
  return { ok, warnings };
}

/**
 * Everyone on all configured Jira sites (real people only, no apps or bots), sorted by name.
 * The same Atlassian account has the same account ID on every site, so people are merged.
 * Needs the "Browse users and groups" global permission on each site.
 * Returns { users: [{ accountId, name, email, sites: [label] }], warnings }
 */
export async function listJiraUsers({ refresh = false } = {}) {
  if (jiraMode() !== "live") return { users: DEMO_USERS, warnings: [] };
  return cached(`users|${cfg().sites.join(",")}`, refresh, async () => {
    const { ok, warnings } = await eachSite(async (site) => {
      const out = [];
      const size = 1000;
      for (let startAt = 0; startAt < 50000; startAt += size) {
        let page;
        try {
          page = await jiraFetch(site, `/rest/api/3/users/search?startAt=${startAt}&maxResults=${size}`);
        } catch (e) {
          if (e.status === 403) throw new Error("this account can't list people here (needs the \"Browse users and groups\" permission)");
          throw e;
        }
        for (const u of page) {
          if (u.accountType !== "atlassian" || u.active === false) continue;
          out.push({ accountId: u.accountId, name: u.displayName || "(no name)", email: u.emailAddress || "" });
        }
        if (page.length < size) break;
      }
      return out;
    });
    const byId = new Map();
    for (const { site, value } of ok) {
      for (const u of value) {
        const cur = byId.get(u.accountId) || { ...u, sites: [] };
        if (!cur.email && u.email) cur.email = u.email;
        cur.sites.push(siteLabel(site));
        byId.set(u.accountId, cur);
      }
    }
    return { users: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
  });
}

/**
 * All Jira projects the account can see, on every configured site.
 * Returns { projects: [{ key, name, site, siteLabel }], warnings }
 */
export async function listJiraProjects({ refresh = false } = {}) {
  if (jiraMode() !== "live") return { projects: DEMO_PROJECTS, warnings: [] };
  return cached(`projects|${cfg().sites.join(",")}`, refresh, async () => {
    const { ok, warnings } = await eachSite(async (site) => {
      const out = [];
      let startAt = 0;
      for (let guard = 0; guard < 200; guard++) {
        const page = await jiraFetch(site, `/rest/api/3/project/search?startAt=${startAt}&maxResults=100&orderBy=key`);
        for (const p of page.values || []) out.push({ key: p.key, name: p.name, site, siteLabel: siteLabel(site) });
        startAt += (page.values || []).length;
        if (page.isLast || !(page.values || []).length) break;
      }
      return out;
    });
    const projects = ok.flatMap((r) => r.value).sort((a, b) => a.key.localeCompare(b.key) || a.siteLabel.localeCompare(b.siteLabel));
    return { projects, warnings };
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
].map(([key, name]) => ({ key, name, site: "", siteLabel: "demo" }));

export async function testConnection() {
  if (jiraMode() !== "live") return { ok: false, mode: "demo", message: "Jira isn't configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN), so the app is in demo mode." };
  const results = await Promise.allSettled(cfg().sites.map((site) => jiraFetch(site, "/rest/api/3/myself")));
  const lines = results.map((r, i) => {
    const label = siteLabel(cfg().sites[i]);
    return r.status === "fulfilled" ? `${label}: connected as ${r.value.displayName}` : `${label}: FAILED (${r.reason?.message || r.reason})`;
  });
  return { ok: results.every((r) => r.status === "fulfilled"), mode: "live", message: lines.join(" · ") };
}

// Saved projects grouped by site: Map(site -> [keys]).
function bySite(projects) {
  const map = new Map();
  for (const p of projects) {
    const site = projectSite(p);
    if (!map.has(site)) map.set(site, []);
    map.get(site).push(p.jiraKey);
  }
  return map;
}

/**
 * Bugs reported by one engineer in the given projects (any sites), created in [start, end).
 * Returns [{ key, site, created, status, rejected }]
 */
export async function fetchBugs({ engineer, projects, start, end, refresh }) {
  if (!projects.length) return [];
  if (jiraMode() !== "live") return demoBugs(engineer, projects.map((p) => p.jiraKey), start, end);
  if (!engineer.jiraAccountId) throw new Error(`${engineer.name} has no Jira account linked (Setup → Engineers).`);
  const c = cfg();
  const rej = normStatus(c.rejected);
  const perSite = await Promise.all([...bySite(projects)].map(([site, keys]) => {
    const jql = `project in (${quoteList(keys)}) AND issuetype = "${c.bugType}" AND reporter = "${engineer.jiraAccountId}" AND created >= "${start}" AND created < "${end}" ORDER BY created ASC`;
    return cached(`bugs|${site}|${jql}`, refresh, async () => {
      const issues = await searchAll(site, jql, ["status", "created"]);
      return issues.map((i) => ({
        key: i.key,
        site,
        created: i.fields.created,
        status: i.fields.status?.name || "",
        rejected: normStatus(i.fields.status?.name) === rej,
      }));
    });
  }));
  return perSite.flat();
}

/**
 * Tickets (any issue type) in the given projects (any sites) that went "In QA" -> "Closed" in [start, end).
 * Returns [{ key, site, startedAt, closedAt, hours }]
 */
export async function fetchCycleTickets({ engineer, projects, start, end, refresh }) {
  if (!projects.length) return [];
  if (jiraMode() !== "live") return demoCycle(engineer, projects.map((p) => p.jiraKey), start, end);
  const c = cfg();
  const perSite = await Promise.all([...bySite(projects)].map(([site, keys]) => {
    const jql = `project in (${quoteList(keys)}) AND status CHANGED TO "${c.closed}" DURING ("${start}", "${end}")`;
    return cached(`cycle|${site}|${jql}`, refresh, async () => {
      const issues = await searchAll(site, jql, ["summary"]);
      if (!issues.length) return [];
      const histories = await statusHistories(site, issues);
      const out = [];
      for (const issue of issues) {
        const r = qaCycleFromHistory(histories.get(issue.key) || [], start, end);
        if (r) out.push({ key: issue.key, site, ...r });
      }
      return out;
    });
  }));
  return perSite.flat();
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
