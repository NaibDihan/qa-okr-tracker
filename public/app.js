// QA OKR Tracker: single-page frontend (vanilla JS, no build step).

// ---------- Utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (key) => { const [y, m] = key.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const now = new Date();
const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const thisQuarter = { year: now.getFullYear(), q: Math.floor(now.getMonth() / 3) + 1 };
// Jira sites (filled from /api/meta). With more than one, projects and tickets show which site they're on.
const multiSite = () => (app.meta?.jira?.sites || []).length > 1;
const siteName = (url) => String(url || "").replace(/^https?:\/\//, "").split(".")[0];
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(-2).map((w) => w[0]).join("").toUpperCase();

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  entry: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  reports: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  setup: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.auth && path !== "/api/login") {
    showLogin();
    throw new Error("Password required");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Password screen (only shown when the server has APP_PASSWORD set).
function showLogin() {
  if ($("#login")) return;
  const el = document.createElement("div");
  el.id = "login";
  el.className = "login-screen";
  el.innerHTML = `
    <form class="card login-card">
      <div class="brand" style="padding:0 0 14px"><span class="brand-mark">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span><span>QA OKR Tracker</span></div>
      <label class="field">Team password<input type="password" name="pw" autocomplete="current-password" required /></label>
      <div class="small" id="login-err" style="color:var(--danger);min-height:18px;margin-top:6px"></div>
      <button class="btn primary" type="submit" style="width:100%">Sign in</button>
    </form>`;
  document.body.appendChild(el);
  const input = $("input", el);
  setTimeout(() => input.focus(), 0);
  $("form", el).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api("/api/login", { method: "POST", body: { password: input.value } });
      location.reload();
    } catch (e) {
      $("#login-err").textContent = e.message;
      input.select();
    }
  });
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), isError ? 4500 : 2200);
}

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

// ---------- App state ----------
const app = { meta: null, engineers: [], projects: [] };

async function loadBase() {
  [app.meta, app.engineers, app.projects] = await Promise.all([api("/api/meta"), api("/api/engineers"), api("/api/projects")]);
  renderJiraChip();
}

function fmt(unit, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (unit === "%") return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
  if (unit === "hours") return `${Number(v).toFixed(2)} h`;
  return String(Math.round(v * 100) / 100);
}

const pill = (status, note) => {
  if (!status) return "";
  const label = app.meta.statusLabels[status] || status;
  return `<span class="pill ${status}" title="${esc(note || "")}">${esc(label)}</span>`;
};

// ---------- Theme ----------
function renderThemeToggle() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("#theme-toggle").innerHTML = `${icon(dark ? "sun" : "moon")}<span>${dark ? "Light mode" : "Dark mode"}</span>`;
}
$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("okr-theme", next); } catch { /* ignore */ }
  renderThemeToggle();
});

function renderJiraChip() {
  const j = app.meta.jira;
  $("#jira-chip").innerHTML = (j.mode === "live"
    ? `<span class="dot live"></span><b>Jira connected</b><div class="small">${esc(j.sites.map((x) => x.label).join(" · "))}</div>`
    : `<span class="dot demo"></span><b>Demo mode</b><div class="small">Jira not connected</div>`)
    + (app.meta.passwordOn ? `<button type="button" class="btn ghost sm" id="sign-out" style="margin-top:6px;padding:2px 0;min-height:0">Sign out</button>` : "");
  $("#sign-out")?.addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    location.reload();
  });
}

// ---------- Navigation ----------
const PAGES = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", render: renderDashboard },
  { id: "entry", label: "Monthly Entry", icon: "entry", render: renderEntry },
  { id: "targets", label: "Targets", icon: "target", render: renderTargets },
  { id: "reports", label: "Reports", icon: "reports", render: renderReports },
  { id: "setup", label: "Setup", icon: "setup", render: renderSetup },
];

function renderNav(active) {
  $("#nav").innerHTML = PAGES.map((p) =>
    `<a href="#/${p.id}" class="${p.id === active ? "active" : ""}">${icon(p.icon)}<span>${p.label}</span></a>`).join("");
}

async function route() {
  const id = (location.hash.replace(/^#\/?/, "") || "dashboard").split("?")[0];
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  renderNav(page.id);
  document.title = `${page.label} · QA OKR Tracker`;
  const view = $("#view");
  view.innerHTML = `<div class="loading"><span class="spin"></span>Loading…</div>`;
  try {
    await page.render(view);
  } catch (e) {
    view.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);

// ---------- Shared: engineer select & period control ----------
const activeEngineers = () => app.engineers.filter((e) => e.active);

function engineerOptions(selected, { includeInactive = false } = {}) {
  const list = includeInactive ? app.engineers : activeEngineers();
  return list.map((e) => `<option value="${e.id}" ${String(e.id) === String(selected) ? "selected" : ""}>${esc(e.name)}${e.active ? "" : " (inactive)"}</option>`).join("");
}

function defaultPeriod() {
  return { mode: "quarter", month: thisMonth, year: clampYear(thisQuarter.year), q: thisQuarter.q, from: `${thisMonth}-01`, to: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` };
}

function periodQuery(p) {
  if (p.mode === "month") return `mode=month&value=${p.month}`;
  if (p.mode === "quarter") return `mode=quarter&value=${p.year}-Q${p.q}`;
  return `mode=custom&from=${p.from}&to=${p.to}`;
}

const YEARS = [2026, 2027, 2028, 2029, 2030];
const clampYear = (y) => Math.min(2030, Math.max(2026, Number(y) || 2026));
function yearOptions(selected) {
  return YEARS.map((y) => `<option ${y === Number(selected) ? "selected" : ""}>${y}</option>`).join("");
}

function periodControl(p) {
  const inputs =
    p.mode === "month"
      ? `<input type="month" data-p="month" value="${p.month}" />`
      : p.mode === "quarter"
        ? `<select data-p="q">${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === Number(p.q) ? "selected" : ""}>Q${q}</option>`).join("")}</select>
           <select data-p="year">${yearOptions(p.year)}</select>`
        : `<input type="date" data-p="from" value="${p.from}" /><span class="to">to</span><input type="date" data-p="to" value="${p.to}" />`;
  return `
    <label class="field">Period
      <div class="segmented" data-role="mode">
        ${["month", "quarter", "custom"].map((m) => `<button type="button" data-mode="${m}" class="${p.mode === m ? "on" : ""}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}
      </div>
    </label>
    <label class="field"><span>&nbsp;</span><div class="period-inputs">${inputs}</div></label>`;
}

function bindPeriodControl(root, p, onChange) {
  $$("[data-mode]", root).forEach((b) => b.addEventListener("click", () => { p.mode = b.dataset.mode; onChange(true); }));
  $$("[data-p]", root).forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.p;
    p[k] = k === "q" || k === "year" ? Number(el.value) : el.value;
    if (p.mode === "custom" && p.from && p.to && p.to < p.from) return toast("End date is before start date", true);
    onChange(false);
  }));
}

// ---------- Shared: KR table ----------
function krTable(result) {
  const { period, rows } = result;
  const isQ = period.mode === "quarter";
  const multi = period.months.length > 1;
  const dir = app.meta.directionLabels;

  const head = `
    <tr>
      <th style="min-width:210px">Key result</th>
      ${isQ ? `<th class="r">Baseline</th><th class="r">Target</th>` : ""}
      ${multi ? period.months.map((m) => `<th class="r">${esc(m.label.split(" ")[0])}</th>`).join("") : `<th class="r">Value</th>`}
      ${multi ? `<th class="r total">${isQ ? "Quarter" : "Total"}</th>` : ""}
      ${isQ ? `<th class="r">% to target</th><th>Status</th>` : ""}
      <th>Notes / comments</th>
    </tr>`;

  let lastCat = null;
  const body = rows.map((r) => {
    let group = "";
    if (r.category !== lastCat) {
      lastCat = r.category;
      group = `<tr class="group"><td colspan="99"><b>${esc(r.category)}</b>${esc(r.objective)}</td></tr>`;
    }
    const monitor = r.direction === "monitor";
    const tgt = (v) => (monitor || v === null || v === undefined ? `<span class="muted">${monitor ? "N/A" : "—"}</span>` : fmt(r.unit, v));
    const monthCells = r.months.map((m) => `<td class="val" title="${esc(m.inputs)}">${esc(m.display)}${multi ? "" : `<span class="inputs">${esc(m.inputs)}</span>`}</td>`).join("");
    return `${group}
      <tr>
        <td>
          <div class="kr-name">${esc(r.name)} <span class="dir ${r.direction}">${esc(dir[r.direction])}</span></div>
          <div class="kr-src">${esc(r.source)}</div>
          ${r.missingMonths.length ? `<div class="missing">Missing manual entry: ${esc(r.missingMonths.join(", "))}</div>` : ""}
        </td>
        ${isQ ? `<td class="val muted">${tgt(r.baseline)}</td><td class="val"><b>${tgt(r.target)}</b></td>` : ""}
        ${monthCells}
        ${multi ? `<td class="val total">${esc(r.total.display)}<span class="inputs">${esc(r.total.inputs)}</span></td>` : ""}
        ${isQ ? `<td class="val">${r.progress === null || r.progress === undefined ? `<span class="muted">—</span>` : r.progress.toFixed(2)}</td>
                 <td>${pill(r.status, r.statusNote)}${r.status === "pending" && r.statusNote ? `<div class="small muted" style="margin-top:4px">${esc(r.statusNote)}</div>` : ""}</td>` : ""}
        <td>${r.comments.length
          ? `<ul class="note-list">${r.comments.map((c) => `<li><span class="m">${esc(c.label.split(" ")[0])}</span>${esc(c.text)}</li>`).join("")}</ul>`
          : `<span class="muted small">—</span>`}</td>
      </tr>`;
  }).join("");

  return `<div class="table-wrap"><table class="kr"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function drillDown(result) {
  const live = app.meta.jira.mode === "live";
  const link = (k, site) => {
    const base = live ? site || app.meta.jira.baseUrl : null;
    const tag = multiSite() && site ? ` <span class="muted small">${esc(siteName(site))}</span>` : "";
    return base ? `<a href="${esc(base)}/browse/${esc(k)}" target="_blank" rel="noopener">${esc(k)}</a>${tag}` : esc(k);
  };
  const { bugs, cycle } = result.details;
  return `
    <details class="drill">
      <summary>Jira tickets behind these numbers <span class="muted small">(${bugs.length} bugs · ${cycle.length} QA cycle tickets)</span></summary>
      <div class="drill-body">
        <div>
          <h3 style="margin-bottom:8px">Bugs reported</h3>
          <div class="scroll"><table class="simple">
            <thead><tr><th>Key</th><th>Created</th><th>Status</th></tr></thead>
            <tbody>${bugs.map((b) => `<tr><td>${link(b.key, b.site)}</td><td class="num">${b.created}</td><td>${b.rejected ? `<span class="pill at-risk">${esc(b.status)}</span>` : esc(b.status)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">None</td></tr>`}</tbody>
          </table></div>
        </div>
        <div>
          <h3 style="margin-bottom:8px">Tickets In QA → Closed</h3>
          <div class="scroll"><table class="simple">
            <thead><tr><th>Key</th><th>Closed</th><th style="text-align:right">Hours in QA</th></tr></thead>
            <tbody>${cycle.map((c) => `<tr><td>${link(c.key, c.site)}</td><td class="num">${c.closed}</td><td class="num" style="text-align:right">${c.hours.toFixed(2)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">None</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>
    </details>`;
}

const noEngineers = () => `
  <div class="card empty">
    <h2>No QA engineers yet</h2>
    <p>Add your engineers and assign their Jira projects to get started.</p>
    <a class="btn primary" href="#/setup">${icon("plus")} Go to Setup</a>
  </div>`;

// ---------- Dashboard ----------
async function renderDashboard(view) {
  await loadBase();
  if (!activeEngineers().length) { view.innerHTML = `<div class="page-head"><div><h1>Dashboard</h1></div></div>${noEngineers()}`; return; }

  const f = store.get("okr-dashboard", { engineerId: null, ...defaultPeriod() });
  f.year = clampYear(f.year);
  if (!activeEngineers().some((e) => String(e.id) === String(f.engineerId))) f.engineerId = activeEngineers()[0].id;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>All key results for one QA engineer across their assigned projects.</p></div>
    </div>
    <div class="stack">
      <div class="card filters" id="filters"></div>
      <div id="result"></div>
    </div>`;

  const drawFilters = () => {
    $("#filters").innerHTML = `
      <label class="field">QA engineer<select id="f-eng">${engineerOptions(f.engineerId)}</select></label>
      ${periodControl(f)}
      <div class="spacer"></div>
      <button class="btn" id="f-refresh" title="Fetch fresh numbers from Jira">${icon("refresh")} Refresh</button>`;
    $("#f-eng").addEventListener("change", (e) => { f.engineerId = Number(e.target.value); load(); });
    $("#f-refresh").addEventListener("click", () => load(true));
    bindPeriodControl($("#filters"), f, (modeChanged) => { if (modeChanged) drawFilters(); load(); });
  };

  const load = async (refresh = false) => {
    store.set("okr-dashboard", f);
    const out = $("#result");
    out.innerHTML = `<div class="card loading"><span class="spin"></span>${app.meta.jira.mode === "live" ? "Fetching from Jira…" : "Loading…"}</div>`;
    try {
      const r = await api(`/api/okr?engineerId=${f.engineerId}&${periodQuery(f)}${refresh ? "&refresh=1" : ""}`);
      out.innerHTML = dashboardBody(r);
      if (refresh) toast("Refreshed from Jira");
    } catch (e) {
      out.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
    }
  };

  drawFilters();
  load();
}

function dashboardBody(r) {
  const t = r.raw.total;
  const isQ = r.period.mode === "quarter";
  const count = (s) => r.rows.filter((x) => x.status === s).length;
  const avg = t.cycleHours.length ? t.cycleHours.reduce((a, b) => a + b, 0) / t.cycleHours.length : null;
  const missing = r.period.months.filter((m) => !r.entriesFound.includes(m.key)).map((m) => m.label.split(" ")[0]);
  const periodNote = isQ ? (r.period.complete ? "Quarter complete" : "Quarter in progress: status shows once it ends") : r.period.mode === "month" ? "Monthly view: values only" : "Custom range: values only";

  return `
    <div class="stack">
      ${r.jiraMode === "demo" ? `<div class="alert">Demo mode: Jira numbers are generated samples. Set the Jira environment variables (in <code>.env</code> locally, or in Vercel) to see real data.</div>` : ""}
      ${r.warnings.map((w) => `<div class="alert">${esc(w)}</div>`).join("")}

      <div class="card card-pad eng-head">
        <div class="avatar">${esc(initials(r.engineer.name))}</div>
        <div>
          <h2 style="font-size:17px">${esc(r.engineer.name)}</h2>
          <div class="muted small">${esc(r.period.label)} · ${esc(periodNote)}</div>
        </div>
        <div class="spacer"></div>
        <div class="chips">${r.projects.map((p) => `<span class="chip">${esc(p)}</span>`).join("") || `<span class="muted small">No projects</span>`}</div>
      </div>

      <div class="tiles">
        <div class="card tile"><div class="label">Bugs reported</div><div class="value">${t.bugsReported}</div><div class="sub">${t.bugsRejected} rejected (Won’t Do)</div></div>
        <div class="card tile"><div class="label">Tickets through QA</div><div class="value">${t.cycleHours.length}</div><div class="sub">Avg ${avg === null ? "—" : avg.toFixed(2) + " h"} from In QA to Closed</div></div>
        <div class="card tile"><div class="label">Manual entries</div><div class="value">${r.entriesFound.length}<span class="muted" style="font-size:15px"> / ${r.period.months.length}</span></div><div class="sub">${missing.length ? `Missing: ${esc(missing.join(", "))}` : "All months entered"}</div></div>
        ${isQ
          ? `<div class="card tile"><div class="label">KR status</div>
               <div class="status-counts">
                 <span class="pill exceeded">${count("exceeded")} Exceeded</span>
                 <span class="pill on-track">${count("on-track")} On Track</span>
                 <span class="pill at-risk">${count("at-risk")} At Risk</span>
               </div>
               <div class="sub" style="margin-top:6px">${count("pending") ? `${count("pending")} pending` : ""}${count("none") ? ` · ${count("none")} without target` : ""}</div></div>`
          : `<div class="card tile"><div class="label">Test cases executed</div><div class="value">${t.test_cases ?? "—"}</div><div class="sub">From monthly entries</div></div>`}
      </div>

      <div class="card">
        <div class="card-head">
          <div><h2>Key results</h2><p>Rates are recalculated from the period's totals; counts are summed.</p></div>
          <a class="btn sm" href="#/entry">${icon("entry")} Enter data</a>
        </div>
        ${krTable(r)}
        ${drillDown(r)}
      </div>
    </div>`;
}

// ---------- Monthly entry ----------
const ENTRY_FIELDS = {
  dde: [{ f: "test_cases", label: "Test cases executed" }],
  pdl: [{ f: "production_bugs", label: "Production bugs found" }],
  otrs: [{ f: "releases", label: "Releases done" }, { f: "signoffs", label: "Sign-offs provided" }],
  scripts: [{ f: "scripts_added", label: "Scripts added" }],
  prs: [{ f: "prs_merged", label: "PRs merged" }],
};

async function renderEntry(view) {
  await loadBase();
  if (!activeEngineers().length) { view.innerHTML = `<div class="page-head"><div><h1>Monthly Entry</h1></div></div>${noEngineers()}`; return; }

  const s = store.get("okr-entry", { engineerId: null, month: thisMonth });
  if (!activeEngineers().some((e) => String(e.id) === String(s.engineerId))) {
    s.engineerId = store.get("okr-dashboard", {}).engineerId || activeEngineers()[0].id;
    if (!activeEngineers().some((e) => String(e.id) === String(s.engineerId))) s.engineerId = activeEngineers()[0].id;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Monthly Entry</h1><p>Enter this month's manual numbers and a comment for any key result. Jira values fill in automatically.</p></div>
    </div>
    <div class="stack">
      <div class="card filters">
        <label class="field">QA engineer<select id="e-eng">${engineerOptions(s.engineerId)}</select></label>
        <label class="field">Month<input type="month" id="e-month" value="${s.month}" max="${thisMonth}" /></label>
        <div class="field" style="flex:1">Recent months<div class="chips" id="e-chips" style="min-height:36px;align-items:center"></div></div>
      </div>
      <div id="e-body"></div>
    </div>`;

  $("#e-eng").addEventListener("change", (e) => { s.engineerId = Number(e.target.value); load(); });
  $("#e-month").addEventListener("change", (e) => { if (e.target.value) { s.month = e.target.value; load(); } });

  const recentMonths = () => {
    const list = [];
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let i = 0; i < 6; i++) { list.unshift(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); d.setMonth(d.getMonth() - 1); }
    return list;
  };

  const load = async () => {
    store.set("okr-entry", s);
    const body = $("#e-body");
    body.innerHTML = `<div class="card loading"><span class="spin"></span>Loading…</div>`;
    try {
      const [entry, okr] = await Promise.all([
        api(`/api/entry?engineerId=${s.engineerId}&month=${s.month}`),
        api(`/api/okr?engineerId=${s.engineerId}&mode=month&value=${s.month}`),
      ]);
      $("#e-chips").innerHTML = recentMonths().map((m) => {
        const done = entry.enteredMonths.includes(m);
        return `<button type="button" class="chip ${done ? "ok" : "miss"}" data-m="${m}" style="cursor:pointer;${m === s.month ? "outline:2px solid var(--accent);outline-offset:1px" : ""}" title="${done ? "Entered" : "Not entered yet"}">${done ? "✓ " : ""}${esc(monthLabel(m).split(" ")[0])}</button>`;
      }).join("");
      $$("#e-chips [data-m]").forEach((b) => b.addEventListener("click", () => { s.month = b.dataset.m; $("#e-month").value = s.month; load(); }));
      drawForm(body, entry, okr);
    } catch (e) {
      body.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
    }
  };

  const drawForm = (body, entry, okr) => {
    const raw = okr.raw.total;
    const values = { ...(entry.entry || {}) };
    const krs = app.meta.krs;

    const preview = (key) => {
      const r = { ...raw };
      for (const f of ["test_cases", "production_bugs", "releases", "signoffs", "scripts_added", "prs_merged"]) {
        r[f] = values[f] === "" || values[f] === undefined || values[f] === null ? null : Number(values[f]);
      }
      const kr = krs.find((k) => k.key === key);
      let v = null;
      if (key === "drr") v = r.bugsReported > 0 ? (r.bugsRejected / r.bugsReported) * 100 : null;
      if (key === "dde") v = r.test_cases > 0 ? ((r.bugsReported - r.bugsRejected) / r.test_cases) * 100 : null;
      if (key === "pdl") v = r.production_bugs !== null && r.bugsReported > 0 ? (r.production_bugs / r.bugsReported) * 100 : null;
      if (key === "cycle") v = r.cycleHours.length ? r.cycleHours.reduce((a, b) => a + b, 0) / r.cycleHours.length : null;
      if (key === "otrs") v = r.releases > 0 && r.signoffs !== null ? (r.signoffs / r.releases) * 100 : null;
      if (key === "scripts") v = r.scripts_added;
      if (key === "prs") v = r.prs_merged;
      return fmt(kr.unit, v);
    };

    const autoLine = (key) => {
      if (key === "drr") return `${raw.bugsRejected} Won’t Do / ${raw.bugsReported} bugs reported`;
      if (key === "dde") return `${raw.bugsReported - raw.bugsRejected} valid bugs from Jira`;
      if (key === "pdl") return `${raw.bugsReported} bugs reported in Jira`;
      if (key === "cycle") return `${raw.cycleHours.length} tickets went In QA → Closed`;
      return "";
    };

    const card = (kr) => {
      const fields = ENTRY_FIELDS[kr.key] || [];
      const isJira = ["drr", "cycle"].includes(kr.key);
      const mixed = ["dde", "pdl"].includes(kr.key);
      return `
        <div class="card kr-card" data-kr="${kr.key}">
          <div class="top">
            <div><h3 style="font-size:14px">${esc(kr.name)}</h3><div class="formula">${esc(kr.formula)}</div></div>
            <span class="tag ${isJira ? "jira" : "manual"}">${isJira ? "Jira" : mixed ? "Jira + Manual" : "Manual"}</span>
          </div>
          ${fields.length ? `<div class="inputs-row ${fields.length === 1 ? "one" : ""}">
            ${fields.map((x) => `<label class="field">${esc(x.label)}<input type="number" min="0" step="1" inputmode="numeric" data-f="${x.f}" value="${values[x.f] ?? ""}" placeholder="0" /></label>`).join("")}
          </div>` : ""}
          <div class="auto">
            <span class="muted">${esc(autoLine(kr.key) || "Result for this month")}</span>
            <span class="v" data-preview="${kr.key}">${preview(kr.key)}</span>
          </div>
          <label class="field">Comment<textarea data-c="${kr.key}" placeholder="Optional: context, blockers, project breakdown…">${esc(entry.comments[kr.key] || "")}</textarea></label>
        </div>`;
    };

    body.innerHTML = `
      ${okr.jiraMode === "demo" ? `<div class="alert" style="margin-bottom:14px">Demo mode: Jira numbers on this page are generated samples.</div>` : ""}
      ${okr.warnings.map((w) => `<div class="alert" style="margin-bottom:14px">${esc(w)}</div>`).join("")}
      <div class="entry-grid">${krs.map(card).join("")}</div>
      <div class="savebar">
        <div><b>${esc(monthLabel(s.month))}</b> · <span class="muted">${esc(app.engineers.find((e) => String(e.id) === String(s.engineerId))?.name || "")}</span>
          <div class="small muted">${entry.entry ? `Last saved ${esc(entry.entry.updated_at)} UTC` : "Not entered yet"}</div></div>
        <div class="spacer"></div>
        <span id="e-warn" class="small" style="color:var(--atrisk-fg)"></span>
        <button class="btn primary" id="e-save">${icon("check")} Save entries</button>
      </div>`;

    const checkWarn = () => {
      const r = Number(values.releases), so = Number(values.signoffs);
      $("#e-warn").textContent = values.releases !== "" && values.signoffs !== "" && values.releases != null && values.signoffs != null && so > r ? "Sign-offs are more than releases" : "";
    };
    $$("[data-f]", body).forEach((inp) => inp.addEventListener("input", () => {
      values[inp.dataset.f] = inp.value;
      const key = inp.closest("[data-kr]").dataset.kr;
      $(`[data-preview="${key}"]`, body).textContent = preview(key);
      checkWarn();
    }));
    checkWarn();

    $("#e-save").addEventListener("click", async () => {
      const btn = $("#e-save");
      btn.disabled = true;
      try {
        const vals = {};
        $$("[data-f]", body).forEach((i) => (vals[i.dataset.f] = i.value));
        const comments = {};
        $$("[data-c]", body).forEach((t) => (comments[t.dataset.c] = t.value));
        await api("/api/entry", { method: "PUT", body: { engineerId: s.engineerId, month: s.month, values: vals, comments } });
        toast(`Saved ${monthLabel(s.month)}`);
        load();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    });
  };

  load();
}

// ---------- Targets ----------
async function renderTargets(view) {
  await loadBase();
  if (!activeEngineers().length) { view.innerHTML = `<div class="page-head"><div><h1>Targets</h1></div></div>${noEngineers()}`; return; }
  const s = store.get("okr-targets", { engineerId: null, year: thisQuarter.year, q: thisQuarter.q });
  s.year = clampYear(s.year);
  if (!activeEngineers().some((e) => String(e.id) === String(s.engineerId))) s.engineerId = activeEngineers()[0].id;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Targets</h1><p>Baseline and target per QA engineer, per quarter. The quarter's result is compared with the target once the quarter ends.</p></div>
    </div>
    <div class="stack">
      <div class="card filters">
        <label class="field">QA engineer<select id="t-eng">${engineerOptions(s.engineerId)}</select></label>
        <label class="field">Quarter<div class="period-inputs">
          <select id="t-q">${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === s.q ? "selected" : ""}>Q${q}</option>`).join("")}</select>
          <select id="t-year">${yearOptions(s.year)}</select></div></label>
        <div class="spacer"></div>
        <button class="btn" id="t-copy">${icon("copy")} Copy previous quarter</button>
      </div>
      <div class="card" id="t-body"></div>
    </div>`;

  const quarter = () => `${s.year}-Q${s.q}`;
  let current = {};

  const draw = () => {
    const krs = app.meta.krs;
    const dirs = app.meta.directionLabels;
    // Input with a unit suffix: "%" for rates, "h" for hours, nothing for counts.
    const unitInput = (kr, k, v) => {
      const suffix = kr.unit === "%" ? "%" : kr.unit === "hours" ? "hours" : "";
      const step = kr.unit === "count" ? "1" : "0.1";
      const max = kr.unit === "%" ? ' max="100"' : "";
      return `<div class="unit-input${suffix ? " has-suffix" : ""}">
        <input type="number" min="0"${max} step="${step}" inputmode="decimal" data-k="${k}" value="${v ?? ""}" placeholder="—" />
        ${suffix ? `<span>${suffix}</span>` : ""}</div>`;
    };
    $("#t-body").innerHTML = `
      <div class="card-head"><div><h2>Q${s.q} ${s.year} targets</h2><p>Type the number only: 5 means 5%, 2.4 means 2.4 hours. Counts are the total for the whole quarter.</p></div></div>
      <div class="table-wrap"><table class="simple">
        <thead><tr><th>Key result</th><th>Status rule</th><th style="width:170px">Baseline</th><th style="width:170px">Target</th></tr></thead>
        <tbody>${krs.map((kr) => {
          const t = current[kr.key] || {};
          const none = kr.rule === "none";
          return `<tr data-kr="${kr.key}">
            <td><div class="kr-name">${esc(kr.name)} <span class="dir ${kr.direction}">${esc(dirs[kr.direction])}</span></div><div class="kr-src">${esc(kr.category)}</div></td>
            <td class="small ${none ? "muted" : ""}">${esc(kr.ruleText)}</td>
            ${none
              ? `<td colspan="2" class="muted small">Shown as a trend only. No target or status.</td>`
              : `<td>${unitInput(kr, "baseline", t.baseline)}</td><td>${unitInput(kr, "target", t.target)}</td>`}
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      <div class="row" style="padding:14px 20px;border-top:1px solid var(--border)">
        <span class="small muted">Status appears on the dashboard after the quarter ends and all three months are entered.</span>
        <div class="spacer"></div>
        <button class="btn" id="t-all">Save for all active QAs</button>
        <button class="btn primary" id="t-save">${icon("check")} Save</button>
      </div>`;

    const collect = () => $$("#t-body tr[data-kr]").map((tr) => ({
      krKey: tr.dataset.kr,
      baseline: $('[data-k="baseline"]', tr)?.value ?? "",
      target: $('[data-k="target"]', tr)?.value ?? "",
    }));
    $("#t-save").addEventListener("click", async () => {
      try {
        await api("/api/targets", { method: "PUT", body: { engineerId: s.engineerId, quarter: quarter(), rows: collect() } });
        toast("Targets saved");
      } catch (e) { toast(e.message, true); }
    });
    $("#t-all").addEventListener("click", async () => {
      if (!confirm(`Apply these targets to all ${activeEngineers().length} active QA engineers for Q${s.q} ${s.year}?`)) return;
      try {
        const rows = collect();
        for (const e of activeEngineers()) await api("/api/targets", { method: "PUT", body: { engineerId: e.id, quarter: quarter(), rows } });
        toast(`Saved for ${activeEngineers().length} engineers`);
      } catch (e) { toast(e.message, true); }
    });
  };

  const load = async () => {
    store.set("okr-targets", s);
    current = await api(`/api/targets?engineerId=${s.engineerId}&quarter=${quarter()}`);
    draw();
  };

  $("#t-eng").addEventListener("change", (e) => { s.engineerId = Number(e.target.value); load(); });
  $("#t-q").addEventListener("change", (e) => { s.q = Number(e.target.value); load(); });
  $("#t-year").addEventListener("change", (e) => { s.year = Number(e.target.value); load(); });
  $("#t-copy").addEventListener("click", async () => {
    const prev = await api(`/api/targets/previous?engineerId=${s.engineerId}&quarter=${quarter()}`);
    if (!Object.keys(prev).length) return toast("No targets in the previous quarter", true);
    current = prev;
    draw();
    toast("Copied. Review and press Save.");
  });
  load();
}

// ---------- Reports ----------
async function renderReports(view) {
  await loadBase();
  if (!activeEngineers().length) { view.innerHTML = `<div class="page-head"><div><h1>Reports</h1></div></div>${noEngineers()}`; return; }
  const s = store.get("okr-report", { ids: activeEngineers().map((e) => e.id), ...defaultPeriod() });
  s.year = clampYear(s.year);
  s.ids = s.ids.filter((id) => activeEngineers().some((e) => e.id === id));

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Reports</h1><p>Generate a report for one QA engineer or a team, view it here and download it as Excel or PDF.</p></div>
    </div>
    <div class="stack">
      <div class="card">
        <div class="card-pad stack" style="gap:14px">
          <div>
            <div class="row" style="justify-content:space-between;margin-bottom:8px">
              <span class="small muted" style="font-weight:500">QA engineers</span>
              <button class="btn ghost sm" id="r-all">Select all</button>
            </div>
            <div class="pick-list" id="r-picks"></div>
          </div>
          <div class="row" style="align-items:flex-end;gap:14px" id="r-period"></div>
        </div>
        <div class="row" style="padding:12px 20px;border-top:1px solid var(--border)">
          <span class="small muted" id="r-hint"></span>
          <div class="spacer"></div>
          <button class="btn primary" id="r-go">Generate report</button>
        </div>
      </div>
      <div id="r-out"></div>
    </div>`;

  const drawPicks = () => {
    $("#r-picks").innerHTML = activeEngineers().map((e) => {
      const on = s.ids.includes(e.id);
      return `<label class="pick ${on ? "on" : ""}"><input type="checkbox" data-id="${e.id}" ${on ? "checked" : ""} />${esc(e.name)}</label>`;
    }).join("");
    $$("#r-picks input").forEach((cb) => cb.addEventListener("change", () => {
      const id = Number(cb.dataset.id);
      s.ids = cb.checked ? [...new Set([...s.ids, id])] : s.ids.filter((x) => x !== id);
      drawPicks();
    }));
    $("#r-hint").textContent = s.ids.length === 0 ? "Pick at least one engineer" : s.ids.length === 1 ? "Individual report" : `Team report · ${s.ids.length} engineers`;
    $("#r-all").textContent = s.ids.length === activeEngineers().length ? "Clear all" : "Select all";
  };
  const drawPeriod = () => {
    $("#r-period").innerHTML = periodControl(s);
    bindPeriodControl($("#r-period"), s, (modeChanged) => { if (modeChanged) drawPeriod(); });
  };
  $("#r-all").addEventListener("click", () => {
    s.ids = s.ids.length === activeEngineers().length ? [] : activeEngineers().map((e) => e.id);
    drawPicks();
  });
  $("#r-go").addEventListener("click", () => generate());

  const generate = async () => {
    if (!s.ids.length) return toast("Pick at least one engineer", true);
    store.set("okr-report", s);
    const out = $("#r-out");
    out.innerHTML = `<div class="card loading"><span class="spin"></span>Building report…</div>`;
    const q = `engineerIds=${s.ids.join(",")}&${periodQuery(s)}`;
    try {
      const rep = await api(`/api/report?${q}`);
      out.innerHTML = reportBody(rep, q);
    } catch (e) {
      out.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
    }
  };

  drawPicks();
  drawPeriod();
}

function reportBody(rep, q) {
  const team = rep.team;
  const isQ = rep.period.mode === "quarter";
  const title = team ? `Team report · ${rep.engineers.length} engineers` : `Individual report · ${rep.engineers[0].engineer.name}`;
  const teamTable = team ? `
    <div class="card">
      <div class="card-head"><div><h2>Team summary</h2><p>Team column is recalculated from everyone's combined numbers.${isQ ? " Cell colour = that engineer's quarter status." : ""}</p></div></div>
      <div class="table-wrap"><table class="kr">
        <thead><tr><th>Key result</th><th>Direction</th>${rep.engineers.map((e) => `<th class="r">${esc(e.engineer.name)}</th>`).join("")}<th class="r total">Team</th></tr></thead>
        <tbody>${team.rows.map((r) => `
          <tr>
            <td><div class="kr-name">${esc(r.name)}</div><div class="kr-src">${esc(r.category)}</div></td>
            <td class="muted" style="white-space:nowrap">${esc(app.meta.directionLabels[r.direction])}</td>
            ${r.perEngineer.map((p) => `<td class="team-cell ${isQ ? p.status || "" : ""}">${esc(p.display)}</td>`).join("")}
            <td class="val total">${esc(r.total.display)}<span class="inputs">${esc(r.total.inputs)}</span></td>
          </tr>`).join("")}</tbody>
      </table></div>
    </div>` : "";

  return `
    <div class="stack">
      <div class="card card-pad report-head">
        <div>
          <h2 style="font-size:17px">${esc(title)}</h2>
          <div class="muted small">${esc(rep.period.label)} · generated ${new Date(rep.generatedAt).toLocaleString()}${rep.jiraMode === "demo" ? " · demo Jira data" : ""}</div>
        </div>
        <div class="row">
          <a class="btn" href="/api/report/export?format=xlsx&${q}" download>${icon("download")} Excel</a>
          <a class="btn" href="/api/report/export?format=pdf&${q}" download>${icon("download")} PDF</a>
        </div>
      </div>
      ${teamTable}
      ${rep.engineers.map((r) => `
        <div class="card">
          <div class="card-head">
            <div class="eng-head">
              <div class="avatar" style="width:32px;height:32px;font-size:12px">${esc(initials(r.engineer.name))}</div>
              <div><h2>${esc(r.engineer.name)}</h2><p>${esc(r.projects.join(", ") || "No projects")}</p></div>
            </div>
            ${isQ ? `<div class="chips">
              <span class="pill exceeded">${r.rows.filter((x) => x.status === "exceeded").length}</span>
              <span class="pill on-track">${r.rows.filter((x) => x.status === "on-track").length}</span>
              <span class="pill at-risk">${r.rows.filter((x) => x.status === "at-risk").length}</span>
            </div>` : ""}
          </div>
          ${r.warnings.map((w) => `<div class="alert" style="margin:12px 20px 0">${esc(w)}</div>`).join("")}
          ${krTable(r)}
        </div>`).join("")}
    </div>`;
}

// ---------- Setup ----------

// Searchable list: an input that filters a scrolling list of items.
function searchList(container, { items, placeholder, empty, itemHtml, searchText, onPick }) {
  container.innerHTML = `
    <input type="search" class="search" placeholder="${esc(placeholder)}" autocomplete="off" />
    <div class="pick-scroll"></div>`;
  const input = $("input", container);
  const list = $(".pick-scroll", container);
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const shown = items.filter((it) => !q || searchText(it).toLowerCase().includes(q)).slice(0, 200);
    list.innerHTML = shown.length
      ? shown.map((it, i) => `<button type="button" class="pick-row" data-i="${items.indexOf(it)}">${itemHtml(it)}</button>`).join("")
      : `<div class="muted small" style="padding:14px">${esc(q ? "No matches" : empty)}</div>`;
    $$(".pick-row", list).forEach((b) => b.addEventListener("click", () => onPick(items[Number(b.dataset.i)])));
  };
  input.addEventListener("input", draw);
  draw();
  setTimeout(() => input.focus(), 0);
}

async function renderSetup(view) {
  await loadBase();
  const j = app.meta.jira;
  const live = j.mode === "live";
  let jiraUsers = null, jiraProjects = null;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Setup</h1><p>Pick your QA engineers from Jira, then assign each one their Jira projects.</p></div>
    </div>
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <div><h2>Jira connection</h2><p>Set by environment variables: the <code>.env</code> file locally, or Project Settings → Environment Variables on Vercel. Restart or redeploy after changing them.</p></div>
          <button class="btn" id="s-test">Test connection</button>
        </div>
        <div class="card-pad grid-2">
          <dl class="kv">
            <dt>Status</dt><dd>${live ? `<span class="dot live"></span>Connected` : `<span class="dot demo"></span>Demo mode (sample people and projects)`}</dd>
            <dt>${j.sites.length > 1 ? "Sites" : "Site"}</dt><dd>${j.sites.length ? j.sites.map((x) => esc(x.url.replace(/^https?:\/\//, ""))).join("<br>") : "—"}</dd>
            <dt>Account</dt><dd>${esc(j.email || "—")}</dd>
          </dl>
          <dl class="kv">
            <dt>Data storage</dt><dd>${app.meta.storage?.kind === "redis" ? "Upstash Redis (cloud)" : app.meta.storage?.kind === "missing" ? `<span style="color:var(--danger)">Not connected</span>` : "Local file"}</dd>
            <dt>Bug issue type</dt><dd><code>${esc(j.bugType)}</code></dd>
            <dt>Rejected status</dt><dd><code>${esc(j.statuses.rejected)}</code></dd>
            <dt>QA statuses</dt><dd><code>${esc(j.statuses.inQa)}</code> → <code>${esc(j.statuses.closed)}</code></dd>
          </dl>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h2>QA engineers</h2><p>Each engineer's KRs combine all of the Jira projects assigned to them.</p></div>
          <button class="btn primary" id="s-add">${icon("plus")} Add QA engineer</button>
        </div>
        <div id="s-picker" class="picker-panel hidden"></div>
        <div id="s-list"></div>
      </div>
    </div>`;

  $("#s-test").addEventListener("click", async () => {
    try { const r = await api("/api/jira/test", { method: "POST" }); toast(r.message, !r.ok); }
    catch (e) { toast(e.message, true); }
  });

  // Both return { users | projects, warnings }. A warning means one Jira site couldn't be read.
  const getUsers = async (refresh) => (jiraUsers = !refresh && jiraUsers ? jiraUsers : await api(`/api/jira/users${refresh ? "?refresh=1" : ""}`));
  const getProjects = async (refresh) => (jiraProjects = !refresh && jiraProjects ? jiraProjects : await api(`/api/jira/projects${refresh ? "?refresh=1" : ""}`));
  const siteWarnings = (w) => (w || []).map((x) => `<div class="alert" style="margin-bottom:8px">Couldn't read one Jira site: ${esc(x)}</div>`).join("");

  // ---- Add engineer picker ----
  const openUserPicker = async (refresh = false) => {
    const panel = $("#s-picker");
    panel.classList.remove("hidden");
    panel.innerHTML = `<div class="loading" style="padding:20px"><span class="spin"></span>Loading people from Jira…</div>`;
    try {
      const { users, warnings } = await getUsers(refresh);
      const added = new Set(app.engineers.map((e) => e.jiraAccountId).filter(Boolean));
      const available = users.filter((u) => !added.has(u.accountId));
      panel.innerHTML = `
        <div class="row" style="justify-content:space-between;margin-bottom:10px">
          <h3>Choose from Jira</h3>
          <div class="row" style="gap:6px">
            <span class="small muted">${available.length} of ${users.length} people available</span>
            <button class="btn sm ghost" id="u-refresh">${icon("refresh")} Refresh</button>
            <button class="btn sm ghost" id="u-close">Close</button>
          </div>
        </div>
        ${siteWarnings(warnings)}
        <div id="u-list"></div>`;
      $("#u-close").addEventListener("click", () => panel.classList.add("hidden"));
      $("#u-refresh").addEventListener("click", () => openUserPicker(true));
      searchList($("#u-list"), {
        items: available,
        placeholder: "Search by name or email…",
        empty: "Everyone from Jira is already added.",
        searchText: (u) => `${u.name} ${u.email}`,
        itemHtml: (u) => `
          <span class="avatar sm">${esc(initials(u.name))}</span>
          <span class="pick-main"><b>${esc(u.name)}</b>${u.email || multiSite() ? `<span class="muted small">${esc([u.email, multiSite() ? (u.sites || []).join(", ") : ""].filter(Boolean).join(" · "))}</span>` : ""}</span>
          <span class="pick-act">${icon("plus")} Add</span>`,
        onPick: async (u) => {
          try {
            await api("/api/engineers", { method: "POST", body: { name: u.name, jiraEmail: u.email, jiraAccountId: u.accountId } });
            toast(`${u.name} added. Now assign their projects.`);
            await loadBase();
            panel.classList.add("hidden");
            drawList();
          } catch (e) { toast(e.message, true); }
        },
      });
    } catch (e) {
      panel.innerHTML = `<div class="alert">${esc(e.message)}</div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="u-retry">Try again</button><button class="btn sm ghost" id="u-close">Close</button></div>`;
      $("#u-retry").addEventListener("click", () => openUserPicker(true));
      $("#u-close").addEventListener("click", () => panel.classList.add("hidden"));
    }
  };
  $("#s-add").addEventListener("click", () => {
    const panel = $("#s-picker");
    if (!panel.classList.contains("hidden")) return panel.classList.add("hidden");
    openUserPicker();
  });

  // ---- Project picker for one engineer ----
  const openProjectPicker = async (eng, slot) => {
    if (!slot.classList.contains("hidden")) { slot.classList.add("hidden"); return; }
    $$(".proj-slot").forEach((s) => s.classList.add("hidden"));
    slot.classList.remove("hidden");
    slot.innerHTML = `<div class="loading" style="padding:14px"><span class="spin"></span>Loading projects from Jira…</div>`;
    try {
      const { projects, warnings } = await getProjects(false);
      // Saved projects come back from /api/projects with their site filled in.
      const owner = (p) => app.projects.find((x) => x.jiraKey === p.key && (!p.site || x.site === p.site));
      const items = projects.filter((p) => owner(p)?.engineerId !== eng.id);
      searchList(slot, {
        items,
        placeholder: `Search ${projects.length} Jira projects by key or name…`,
        empty: "All projects are already assigned to this engineer.",
        searchText: (p) => `${p.key} ${p.name} ${p.siteLabel || ""}`,
        itemHtml: (p) => {
          const o = owner(p);
          const ownerName = o?.engineerId ? app.engineers.find((e) => e.id === o.engineerId)?.name : null;
          return `<span class="proj-key">${esc(p.key)}</span>
            <span class="pick-main"><b>${esc(p.name)}</b>${ownerName || multiSite() ? `<span class="muted small">${esc([multiSite() ? p.siteLabel : "", ownerName ? `Currently: ${ownerName}` : ""].filter(Boolean).join(" · "))}</span>` : ""}</span>
            <span class="pick-act">${icon("plus")} ${ownerName ? "Move here" : "Assign"}</span>`;
        },
        onPick: async (p) => {
          const o = owner(p);
          const ownerName = o?.engineerId ? app.engineers.find((e) => e.id === o.engineerId)?.name : null;
          if (ownerName && !confirm(`${p.key} is assigned to ${ownerName}. A project has one QA. Move it to ${eng.name}?`)) return;
          try {
            await api("/api/projects/assign", { method: "PUT", body: { jiraKey: p.key, name: p.name, engineerId: eng.id, site: p.site || "" } });
            toast(`${p.key} assigned to ${eng.name}`);
            await loadBase();
            drawList();
          } catch (e) { toast(e.message, true); }
        },
      });
      if (warnings?.length) slot.insertAdjacentHTML("afterbegin", siteWarnings(warnings));
    } catch (e) {
      slot.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
    }
  };

  // ---- Engineer list ----
  const drawList = () => {
    const list = $("#s-list");
    if (!app.engineers.length) {
      list.innerHTML = `<div class="empty"><h2>No QA engineers yet</h2><p>Press <b>Add QA engineer</b> to pick people from Jira.</p></div>`;
      return;
    }
    list.innerHTML = app.engineers.map((e) => {
      const projs = app.projects.filter((p) => p.engineerId === e.id);
      return `
        <div class="eng-row" data-id="${e.id}">
          <div class="eng-main">
            <div class="avatar ${e.active ? "" : "off"}">${esc(initials(e.name))}</div>
            <div style="min-width:0">
              <div class="kr-name">${esc(e.name)}${e.active ? "" : ` <span class="dir">Inactive</span>`}</div>
              <div class="muted small ellipsis">${esc(e.jiraEmail || (e.jiraAccountId ? `Jira ID ${e.jiraAccountId}` : "Not linked to Jira"))}</div>
            </div>
          </div>
          <div class="eng-projects">
            ${projs.map((p) => `<span class="chip proj" title="${esc(p.name)}${p.site ? ` · ${esc(siteName(p.site))}` : ""}">${esc(p.jiraKey)}${multiSite() && p.site ? `<span class="chip-site">${esc(siteName(p.site))}</span>` : ""}<button type="button" data-unassign="${p.id}" aria-label="Remove ${esc(p.jiraKey)}">×</button></span>`).join("")}
            <button type="button" class="btn sm" data-addproj>${icon("plus")} Project</button>
          </div>
          <div class="eng-actions">
            <label class="switch" title="Inactive engineers are hidden from the dashboard, entry and reports"><input type="checkbox" data-active ${e.active ? "checked" : ""} />Active</label>
            <button class="btn sm ghost danger" data-del>Remove</button>
          </div>
          <div class="proj-slot picker-panel hidden"></div>
        </div>`;
    }).join("");

    $$(".eng-row").forEach((row) => {
      const eng = app.engineers.find((x) => x.id === Number(row.dataset.id));
      $("[data-addproj]", row).addEventListener("click", () => openProjectPicker(eng, $(".proj-slot", row)));
      $$("[data-unassign]", row).forEach((b) => b.addEventListener("click", async () => {
        try {
          await api(`/api/projects/${b.dataset.unassign}`, { method: "DELETE" });
          await loadBase();
          drawList();
        } catch (e) { toast(e.message, true); }
      }));
      $("[data-active]", row).addEventListener("change", async (ev) => {
        try {
          await api(`/api/engineers/${eng.id}`, { method: "PUT", body: { active: ev.target.checked } });
          await loadBase();
          drawList();
        } catch (e) { toast(e.message, true); }
      });
      $("[data-del]", row).addEventListener("click", async () => {
        if (!confirm(`Remove ${eng.name}? This deletes their monthly entries, comments and targets, and unassigns their projects.`)) return;
        try {
          await api(`/api/engineers/${eng.id}`, { method: "DELETE" });
          toast("Removed");
          await loadBase();
          drawList();
        } catch (e) { toast(e.message, true); }
      });
    });
  };

  drawList();
}

// ---------- Boot ----------
renderThemeToggle();
route();
