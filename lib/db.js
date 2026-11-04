// Data access. Storage is a local JSON file or Upstash Redis (see lib/store.js).
import { createStore } from "./store.js";

let store;

export function openDb(dataDir, { prefer } = {}) {
  if (!store) store = createStore({ dataDir, prefer });
  return store;
}
export const storeInfo = () => ({ kind: store?.kind, where: store?.where });

const nowStamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const all = async (coll) => (await store.batch([["hgetall", coll]]))[0];
const err = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- Engineers ----------
export async function listEngineers() {
  return Object.values(await all("engineers")).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
}

export async function getEngineer(id) {
  return (await all("engineers"))[String(Number(id))];
}

export async function createEngineer({ name, jiraEmail, jiraAccountId, active = true }) {
  if (!name || !name.trim()) throw err("Name is required");
  const acc = (jiraAccountId || "").trim();
  const existing = Object.values(await all("engineers"));
  if (acc && existing.some((e) => e.jiraAccountId === acc)) throw err(`${name.trim()} is already added`);
  const [id] = await store.batch([["incr", "engineers"]]);
  const e = { id, name: name.trim(), jiraEmail: (jiraEmail || "").trim(), jiraAccountId: acc, active: !!active };
  await store.batch([["hset", "engineers", String(id), e]]);
  return e;
}

export async function updateEngineer(id, { name, jiraEmail, jiraAccountId, active }) {
  const e = await getEngineer(id);
  if (!e) throw err("Engineer not found", 404);
  if (name !== undefined) {
    if (!name.trim()) throw err("Name is required");
    e.name = name.trim();
  }
  if (jiraEmail !== undefined) e.jiraEmail = jiraEmail.trim();
  if (jiraAccountId !== undefined) e.jiraAccountId = jiraAccountId.trim();
  if (active !== undefined) e.active = !!active;
  await store.batch([["hset", "engineers", String(e.id), e]]);
  return e;
}

export async function deleteEngineer(id) {
  const n = String(Number(id));
  const [projects, entries, comments, targets] = await store.batch([
    ["hgetall", "projects"], ["hgetall", "entries"], ["hgetall", "comments"], ["hgetall", "targets"],
  ]);
  const mine = (bag) => Object.keys(bag).filter((k) => k.split("|")[0] === n);
  await store.batch([
    ["hdel", "engineers", n],
    ...Object.values(projects).filter((p) => String(p.engineerId) === n)
      .map((p) => ["hset", "projects", String(p.id), { ...p, engineerId: null }]),
    ["hdel", "entries", ...mine(entries)],
    ["hdel", "comments", ...mine(comments)],
    ["hdel", "targets", ...mine(targets)],
  ]);
}

// ---------- Projects ----------
export async function listProjects() {
  return Object.values(await all("projects")).sort((a, b) => a.jiraKey.localeCompare(b.jiraKey));
}

export async function projectsForEngineer(engineerId) {
  return (await listProjects()).filter((p) => p.engineerId === Number(engineerId));
}

const cleanKey = (k) => {
  const key = (k || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]+$/.test(key)) throw err("Jira project key looks invalid (e.g. KEY, EMC)");
  return key;
};

export async function createProject({ jiraKey, name, engineerId }) {
  const key = cleanKey(jiraKey);
  if ((await listProjects()).some((p) => p.jiraKey === key)) throw err(`Project ${key} already exists`);
  const [id] = await store.batch([["incr", "projects"]]);
  const p = { id, jiraKey: key, name: (name || "").trim(), engineerId: engineerId ? Number(engineerId) : null };
  await store.batch([["hset", "projects", String(id), p]]);
  return p;
}

export async function updateProject(id, { jiraKey, name, engineerId }) {
  const projects = await listProjects();
  const p = projects.find((x) => x.id === Number(id));
  if (!p) throw err("Project not found", 404);
  if (jiraKey !== undefined) {
    const key = cleanKey(jiraKey);
    if (projects.some((x) => x.jiraKey === key && x.id !== p.id)) throw err(`Project ${key} already exists`);
    p.jiraKey = key;
  }
  if (name !== undefined) p.name = (name || "").trim();
  if (engineerId !== undefined) p.engineerId = engineerId ? Number(engineerId) : null;
  await store.batch([["hset", "projects", String(p.id), p]]);
  return p;
}

// Assign a Jira project to an engineer (creates it, or moves it from another engineer).
export async function assignProject({ jiraKey, name, engineerId }) {
  const key = cleanKey(jiraKey);
  if (!(await getEngineer(engineerId))) throw err("Engineer not found", 404);
  let p = (await listProjects()).find((x) => x.jiraKey === key);
  if (p) {
    p.engineerId = Number(engineerId);
    if (name) p.name = name.trim();
  } else {
    const [id] = await store.batch([["incr", "projects"]]);
    p = { id, jiraKey: key, name: (name || "").trim(), engineerId: Number(engineerId) };
  }
  await store.batch([["hset", "projects", String(p.id), p]]);
  return p;
}

export async function deleteProject(id) {
  await store.batch([["hdel", "projects", String(Number(id))]]);
}

// ---------- Manual entries ----------
export const MANUAL_FIELDS = ["test_cases", "production_bugs", "releases", "signoffs", "scripts_added", "prs_merged"];

export async function getEntries(engineerId, months) {
  const entries = await all("entries");
  const out = {};
  for (const m of months) {
    const e = entries[`${Number(engineerId)}|${m}`];
    if (e) out[m] = e;
  }
  return out;
}

export async function saveEntry(engineerId, month, values) {
  const clean = {};
  for (const f of MANUAL_FIELDS) {
    const v = values[f];
    if (v === "" || v === null || v === undefined) { clean[f] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw err(`${f.replace(/_/g, " ")} must be a whole number ≥ 0`);
    clean[f] = n;
  }
  await store.batch([["hset", "entries", `${Number(engineerId)}|${month}`, { ...clean, updated_at: nowStamp() }]]);
}

export async function entryMonthsForEngineer(engineerId) {
  const prefix = `${Number(engineerId)}|`;
  return Object.keys(await all("entries")).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
}

// ---------- Comments ----------
export async function getComments(engineerId, months) {
  const out = [];
  for (const [k, v] of Object.entries(await all("comments"))) {
    const [eid, month, krKey] = k.split("|");
    if (eid === String(Number(engineerId)) && months.includes(month)) out.push({ month, krKey, text: v.text });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month));
}

export async function saveComments(engineerId, month, comments) {
  const cmds = [];
  const remove = [];
  for (const [krKey, text] of Object.entries(comments || {})) {
    const k = `${Number(engineerId)}|${month}|${krKey}`;
    const t = (text || "").trim();
    if (t) cmds.push(["hset", "comments", k, { text: t, updated_at: nowStamp() }]);
    else remove.push(k);
  }
  await store.batch([...cmds, ["hdel", "comments", ...remove]]);
}

// ---------- Targets ----------
export async function getTargets(engineerId, quarter) {
  const out = {};
  const prefix = `${Number(engineerId)}|${quarter}|`;
  for (const [k, v] of Object.entries(await all("targets"))) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

export async function saveTargets(engineerId, quarter, rows) {
  const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
  for (const r of rows) {
    const b = num(r.baseline), t = num(r.target);
    if ((b !== null && !Number.isFinite(b)) || (t !== null && !Number.isFinite(t))) throw err("Baseline and target must be numbers");
    if ((b !== null && b < 0) || (t !== null && t < 0)) throw err("Baseline and target can't be negative");
  }
  await store.batch(rows.map((r) => ["hset", "targets", `${Number(engineerId)}|${quarter}|${r.krKey}`, { baseline: num(r.baseline), target: num(r.target) }]));
}
