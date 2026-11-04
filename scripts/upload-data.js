// Copies your LOCAL data (data/okr.json) into the cloud database (Upstash Redis) that Vercel uses.
//
// 1. In Vercel: Storage → your Upstash database → ".env.local" tab → copy KV_REST_API_URL and KV_REST_API_TOKEN.
// 2. Paste both lines into your local .env file.
// 3. Run: npm run upload-data            (refuses if the cloud database already has engineers)
//         npm run upload-data -- --force (wipes the cloud database first, then uploads)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../lib/env.js";
import { createStore, COLLECTIONS, redisConfig } from "../lib/store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(ROOT);

if (!redisConfig()) {
  console.error("KV_REST_API_URL and KV_REST_API_TOKEN aren't in your .env file. See the steps at the top of this script.");
  process.exit(1);
}

const local = createStore({ dataDir: path.join(ROOT, "data"), prefer: "file" });
const cloud = createStore({ prefer: "redis" });

const localData = await local.batch(COLLECTIONS.map((c) => ["hgetall", c]));
const [cloudEngineers] = await cloud.batch([["hgetall", "engineers"]]);

if (Object.keys(cloudEngineers).length && !process.argv.includes("--force")) {
  console.error(`The cloud database already has ${Object.keys(cloudEngineers).length} engineer(s).`);
  console.error("Run `npm run upload-data -- --force` to replace everything in the cloud with your local data.");
  process.exit(1);
}
if (process.argv.includes("--force")) await cloud.wipe();

const cmds = [];
COLLECTIONS.forEach((c, i) => {
  for (const [field, value] of Object.entries(localData[i])) cmds.push(["hset", c, field, value]);
});
// Continue numbering after the highest local ids.
const maxId = (obj) => Math.max(0, ...Object.values(obj).map((r) => Number(r.id) || 0));
cmds.push(["setseq", "engineers", maxId(localData[0])], ["setseq", "projects", maxId(localData[1])]);

for (let i = 0; i < cmds.length; i += 200) await cloud.batch(cmds.slice(i, i + 200));

const counts = COLLECTIONS.map((c, i) => `${Object.keys(localData[i]).length} ${c}`).join(", ");
console.log(`Uploaded to ${cloud.where}: ${counts}.`);
