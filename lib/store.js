// Storage backends behind one tiny interface.
//
//   - Local (npm start): a JSON file, data/okr.json.
//   - Vercel / any host: Upstash Redis over its REST API (plain fetch, no packages).
//
// Data lives in "collections" (Redis hashes): engineers, projects, entries, comments, targets.
// Every write touches a single record, so two people saving different things at the
// same time never overwrite each other.
//
// One primitive: batch([...commands]) where a command is
//   ["hgetall", coll]               -> { field: value }
//   ["hset", coll, field, value]    -> value is any JSON value
//   ["hdel", coll, ...fields]
//   ["incr", name]                  -> next integer (for ids)
//   ["setseq", name, n]             -> set the id counter (used when copying data)
import fs from "node:fs";
import path from "node:path";

export const COLLECTIONS = ["engineers", "projects", "entries", "comments", "targets"];

// ---------- Local JSON file ----------
function fileStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "okr.json");
  let data = { seq: {}, ...Object.fromEntries(COLLECTIONS.map((c) => [c, {}])) };

  if (fs.existsSync(file)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Could not read ${file}: ${e.message}. Fix or remove the file and start again.`);
    }
    // Older versions stored engineers/projects as arrays: convert to { id: record }.
    for (const c of ["engineers", "projects"]) {
      if (Array.isArray(raw[c])) raw[c] = Object.fromEntries(raw[c].map((r) => [String(r.id), r]));
    }
    // Older versions kept a "direction" on targets; it's now fixed per KR.
    for (const t of Object.values(raw.targets || {})) delete t.direction;
    data = { ...data, ...raw, seq: { ...(raw.seq || {}) } };
    delete data.version;
  }

  const save = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };
  if (!fs.existsSync(file)) save();

  return {
    kind: "file",
    where: file,
    async batch(cmds) {
      let dirty = false;
      const out = cmds.map(([op, a, ...rest]) => {
        if (op === "hgetall") return JSON.parse(JSON.stringify(data[a] || {}));
        if (op === "hset") { data[a][rest[0]] = JSON.parse(JSON.stringify(rest[1])); dirty = true; return 1; }
        if (op === "hdel") { for (const f of rest) delete data[a][f]; dirty = true; return rest.length; }
        if (op === "incr") { data.seq[a] = (data.seq[a] || 0) + 1; dirty = true; return data.seq[a]; }
        if (op === "setseq") { data.seq[a] = Number(rest[0]); dirty = true; return 1; }
        throw new Error(`Unknown store op ${op}`);
      });
      if (dirty) save();
      return out;
    },
    async wipe() {
      data = { seq: {}, ...Object.fromEntries(COLLECTIONS.map((c) => [c, {}])) };
      save();
    },
  };
}

// ---------- Upstash Redis (REST) ----------
function redisStore(url, token) {
  const base = url.replace(/\/+$/, "");
  const key = (name) => `okr:${name}`;

  async function pipeline(commands) {
    if (!commands.length) return [];
    const res = await fetch(`${base}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`Database error (${res.status}): ${text.slice(0, 200)}`), { status: 503 });
    }
    const results = await res.json();
    for (const r of results) {
      if (r.error) throw Object.assign(new Error(`Database error: ${r.error}`), { status: 503 });
    }
    return results.map((r) => r.result);
  }

  return {
    kind: "redis",
    where: base.replace(/^https?:\/\//, ""),
    async batch(cmds) {
      const sent = [];
      const map = []; // index in cmds -> index in sent (or -1 when skipped)
      for (const [op, a, ...rest] of cmds) {
        if (op === "hgetall") { map.push(sent.length); sent.push(["HGETALL", key(a)]); }
        else if (op === "hset") { map.push(sent.length); sent.push(["HSET", key(a), String(rest[0]), JSON.stringify(rest[1])]); }
        else if (op === "hdel") {
          if (!rest.length) { map.push(-1); continue; }
          map.push(sent.length); sent.push(["HDEL", key(a), ...rest.map(String)]);
        }
        else if (op === "incr") { map.push(sent.length); sent.push(["INCR", key(`seq:${a}`)]); }
        else if (op === "setseq") { map.push(sent.length); sent.push(["SET", key(`seq:${a}`), String(Number(rest[0]))]); }
        else throw new Error(`Unknown store op ${op}`);
      }
      const results = await pipeline(sent);
      return cmds.map(([op], i) => {
        const r = map[i] === -1 ? 0 : results[map[i]];
        if (op !== "hgetall") return r;
        const obj = {};
        for (let j = 0; j < (r || []).length; j += 2) obj[r[j]] = JSON.parse(r[j + 1]);
        return obj;
      });
    },
    async wipe() {
      await pipeline([
        ...COLLECTIONS.map((c) => ["DEL", key(c)]),
        ["DEL", key("seq:engineers")], ["DEL", key("seq:projects")],
      ]);
    },
  };
}

// ---------- Pick a backend ----------
export function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return url && token ? { url, token } : null;
}

export function createStore({ dataDir, prefer } = {}) {
  const redis = redisConfig();
  if (prefer !== "file" && redis) return redisStore(redis.url, redis.token);
  if (prefer === "redis") throw new Error("Redis isn't configured (KV_REST_API_URL / KV_REST_API_TOKEN).");
  if (process.env.VERCEL) {
    // Vercel's disk is read-only and wiped between requests, so a file can't hold the data.
    return {
      kind: "missing",
      where: "",
      async batch() {
        throw Object.assign(
          new Error("No database connected. In Vercel open your project → Storage → add \"Upstash for Redis\" (free), connect it to this project, then redeploy."),
          { status: 503 },
        );
      },
      async wipe() {},
    };
  }
  return fileStore(dataDir);
}
