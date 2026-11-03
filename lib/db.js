// Storage: a single JSON file (data/okr.json). Works on Node 18+ with no dependencies.
// Writes are atomic (write to a temp file, then rename), so a crash can't corrupt the data.
import fs from "node:fs";
import path from "node:path";

let file;
let data;

const nowStamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function emptyData() {
  return { version: 1, seq: { engineers: 0, projects: 0 }, engineers: [], projects: [], entries: {}, comments: {}, targets: {} };
}

function save() {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function openDb(dataDir) {
  if (data) return data;
  fs.mkdirSync(dataDir, { recursive: true });
  file = path.join(dataDir, "okr.json");
  if (fs.existsSync(file)) {
    try {
      data = { ...emptyData(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (e) {
      throw new Error(`Could not read ${file}: ${e.message}. Fix or remove the file and start again.`);
    }
  } else {
    data = emptyData();
    save();
  }
  return data;
}

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);

// ---------- Engineers ----------
export function listEngineers() {
  return clone([...data.engineers].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name)));
}

export function getEngineer(id) {
  return clone(data.engineers.find((e) => e.id === Number(id)));
}

export function createEngineer({ name, jiraEmail, jiraAccountId, active = true }) {
  if (!name || !name.trim()) throw new Error("Name is required");
  const acc = (jiraAccountId || "").trim();
  if (acc && data.engineers.some((e) => e.jiraAccountId === acc)) throw new Error(`${name.trim()} is already added`);
  const e = {
    id: ++data.seq.engineers,
    name: name.trim(),
    jiraEmail: (jiraEmail || "").trim(),
    jiraAccountId: (jiraAccountId || "").trim(),
    active: !!active,
  };
  data.engineers.push(e);
  save();
  return clone(e);
}

export function updateEngineer(id, { name, jiraEmail, jiraAccountId, active }) {
  const e = data.engineers.find((x) => x.id === Number(id));
  if (!e) throw new Error("Engineer not found");
  if (name !== undefined) {
    if (!name.trim()) throw new Error("Name is required");
    e.name = name.trim();
  }
  if (jiraEmail !== undefined) e.jiraEmail = jiraEmail.trim();
  if (jiraAccountId !== undefined) e.jiraAccountId = jiraAccountId.trim();
  if (active !== undefined) e.active = !!active;
  save();
  return clone(e);
}

export function deleteEngineer(id) {
  const n = Number(id);
  data.engineers = data.engineers.filter((e) => e.id !== n);
  for (const p of data.projects) if (p.engineerId === n) p.engineerId = null;
  for (const bag of [data.entries, data.comments, data.targets]) {
    for (const k of Object.keys(bag)) if (k.split("|")[0] === String(n)) delete bag[k];
  }
  save();
}

// ---------- Projects ----------
export function listProjects() {
  return clone([...data.projects].sort((a, b) => a.jiraKey.localeCompare(b.jiraKey)));
}

export function projectsForEngineer(engineerId) {
  return listProjects().filter((p) => p.engineerId === Number(engineerId));
}

const cleanKey = (k) => {
  const key = (k || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]+$/.test(key)) throw new Error("Jira project key looks invalid (e.g. KEY, EMC)");
  return key;
};

export function createProject({ jiraKey, name, engineerId }) {
  const key = cleanKey(jiraKey);
  if (data.projects.some((p) => p.jiraKey === key)) throw new Error(`Project ${key} already exists`);
  const p = { id: ++data.seq.projects, jiraKey: key, name: (name || "").trim(), engineerId: engineerId ? Number(engineerId) : null };
  data.projects.push(p);
  save();
  return clone(p);
}

export function updateProject(id, { jiraKey, name, engineerId }) {
  const p = data.projects.find((x) => x.id === Number(id));
  if (!p) throw new Error("Project not found");
  if (jiraKey !== undefined) {
    const key = cleanKey(jiraKey);
    if (data.projects.some((x) => x.jiraKey === key && x.id !== p.id)) throw new Error(`Project ${key} already exists`);
    p.jiraKey = key;
  }
  if (name !== undefined) p.name = (name || "").trim();
  if (engineerId !== undefined) p.engineerId = engineerId ? Number(engineerId) : null;
  save();
  return clone(p);
}

export function assignProject({ jiraKey, name, engineerId }) {
  const key = cleanKey(jiraKey);
  if (!data.engineers.some((e) => e.id === Number(engineerId))) throw new Error("Engineer not found");
  let p = data.projects.find((x) => x.jiraKey === key);
  if (p) {
    p.engineerId = Number(engineerId);
    if (name) p.name = name.trim();
  } else {
    p = { id: ++data.seq.projects, jiraKey: key, name: (name || "").trim(), engineerId: Number(engineerId) };
    data.projects.push(p);
  }
  save();
  return clone(p);
}

export function deleteProject(id) {
  data.projects = data.projects.filter((p) => p.id !== Number(id));
  save();
}

// ---------- Manual entries ----------
export const MANUAL_FIELDS = ["test_cases", "production_bugs", "releases", "signoffs", "scripts_added", "prs_merged"];

export function getEntries(engineerId, months) {
  const out = {};
  for (const m of months) {
    const e = data.entries[`${Number(engineerId)}|${m}`];
    if (e) out[m] = clone(e);
  }
  return out;
}

export function saveEntry(engineerId, month, values) {
  const clean = {};
  for (const f of MANUAL_FIELDS) {
    const v = values[f];
    if (v === "" || v === null || v === undefined) { clean[f] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error(`${f.replace(/_/g, " ")} must be a whole number ≥ 0`);
    clean[f] = n;
  }
  data.entries[`${Number(engineerId)}|${month}`] = { ...clean, updated_at: nowStamp() };
  save();
}

export function entryMonthsForEngineer(engineerId) {
  const prefix = `${Number(engineerId)}|`;
  return Object.keys(data.entries).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
}

// ---------- Comments ----------
export function getComments(engineerId, months) {
  const out = [];
  for (const [k, v] of Object.entries(data.comments)) {
    const [eid, month, krKey] = k.split("|");
    if (eid === String(Number(engineerId)) && months.includes(month)) out.push({ month, krKey, text: v.text });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month));
}

export function saveComments(engineerId, month, comments) {
  for (const [krKey, text] of Object.entries(comments || {})) {
    const k = `${Number(engineerId)}|${month}|${krKey}`;
    const t = (text || "").trim();
    if (t) data.comments[k] = { text: t, updated_at: nowStamp() };
    else delete data.comments[k];
  }
  save();
}

// ---------- Targets ----------
export function getTargets(engineerId, quarter) {
  const out = {};
  const prefix = `${Number(engineerId)}|${quarter}|`;
  for (const [k, v] of Object.entries(data.targets)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = clone(v);
  return out;
}

export function saveTargets(engineerId, quarter, rows) {
  const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
  for (const r of rows) {
    const b = num(r.baseline), t = num(r.target);
    if ((b !== null && !Number.isFinite(b)) || (t !== null && !Number.isFinite(t))) throw new Error("Baseline and target must be numbers");
    if ((b !== null && b < 0) || (t !== null && t < 0)) throw new Error("Baseline and target can't be negative");
  }
  for (const r of rows) {
    data.targets[`${Number(engineerId)}|${quarter}|${r.krKey}`] = { baseline: num(r.baseline), target: num(r.target) };
  }
  save();
}
