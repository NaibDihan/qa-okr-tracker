// Bitbucket Cloud client for the two automation KRs:
//   - PR Merged (Automation):       pull requests merged into the main branch, by author
//   - Automated Test Scripts Added: NEW Playwright test() functions in those PRs
//
// Settings (.env locally, Environment Variables on Vercel):
//   BITBUCKET_REPOS=asthait/playwright_automation     (workspace/repo, several separated by commas)
//   BITBUCKET_BRANCH=main                              (only PRs merged into this branch count)
//   BITBUCKET_EMAIL=you@company.com                    (your Atlassian account email)
//   BITBUCKET_API_TOKEN=...                            (API token with scopes: read:repository:bitbucket, read:pullrequest:bitbucket)
// When these aren't set, the two KRs stay fully manual.

const API = "https://api.bitbucket.org/2.0";

const cfg = () => ({
  repos: [...new Set((process.env.BITBUCKET_REPOS || "").split(/[,\s]+/).map((r) => r.trim().replace(/^\/+|\/+$/g, "")).filter((r) => /^[^/]+\/[^/]+$/.test(r)))],
  branch: (process.env.BITBUCKET_BRANCH || "main").trim(),
  email: (process.env.BITBUCKET_EMAIL || "").trim(),
  token: (process.env.BITBUCKET_API_TOKEN || "").trim(),
  cacheMs: Number(process.env.JIRA_CACHE_MINUTES || 10) * 60 * 1000,
});

export function bitbucketEnabled() {
  const c = cfg();
  return !!(c.repos.length && c.email && c.token);
}

export function bitbucketInfo() {
  const c = cfg();
  return { enabled: bitbucketEnabled(), repos: c.repos, branch: c.branch };
}

// ---------- HTTP ----------
async function bbFetch(url, { text = false } = {}) {
  const c = cfg();
  const auth = Buffer.from(`${c.email}:${c.token}`).toString("base64");
  const res = await fetch(url.startsWith("http") ? url : API + url, {
    headers: { Authorization: `Basic ${auth}`, Accept: text ? "text/plain" : "application/json" },
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j?.error?.message || ""; } catch { /* ignore */ }
    const err = new Error(`Bitbucket ${res.status} on ${new URL(url, API).pathname}${detail ? ": " + detail : ""}`);
    err.status = res.status;
    err.upstream = true;
    throw err;
  }
  return text ? res.text() : res.json();
}

// Follows Bitbucket's "next" links.
async function pages(firstUrl, max = 100) {
  const out = [];
  let url = firstUrl;
  for (let i = 0; url && i < max; i++) {
    const page = await bbFetch(url);
    out.push(...(page.values || []));
    url = page.next || null;
  }
  return out;
}

// Runs fn over items with at most `limit` running at once.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// ---------- Counting new tests in a diff ----------
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
// test('title', ...), test.only / skip / fixme / fail / slow ('title', ...).
// Not counted: test.describe, test.step, hooks (beforeEach ...), test.use, someRegex.test(...).
const TEST_CALL = /(?:^|[^.\w$])test(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*)\1|$)/;
const TITLE_ONLY = /^\s*(['"`])((?:\\.|(?!\1).)*)\1/;

/**
 * Counts Playwright tests that a diff ADDS. A test whose title appears in both the removed
 * and the added lines (an edited or moved test) is not new, so it isn't counted.
 * Returns { added: number, titles: [string] }.
 */
export function countNewTests(diffText) {
  const added = [], removed = [];
  let inCode = false;
  const pending = { "+": false, "-": false }; // `test(` at the end of a line, title on the next line
  for (const line of String(diffText).split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.+)$/) || line.match(/ a\/(.+?) /);
      inCode = !!(m && CODE_FILE.test(m[1]));
      pending["+"] = pending["-"] = false;
      continue;
    }
    if (!inCode || line.startsWith("+++") || line.startsWith("---")) continue;
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    const code = line.slice(1);
    if (/^\s*(\/\/|\/\*|\*)/.test(code)) continue; // comment lines don't define tests
    const list = sign === "+" ? added : removed;
    if (pending[sign]) {
      pending[sign] = false;
      const t = code.match(TITLE_ONLY);
      if (t) { list.push(t[2]); continue; }
    }
    const m = code.match(TEST_CALL);
    if (!m) continue;
    if (m[1]) list.push(m[2]);
    else pending[sign] = true;
  }
  // New = added titles not matched by a removed title (multiset difference).
  const left = new Map();
  for (const t of removed) left.set(t, (left.get(t) || 0) + 1);
  const titles = [];
  for (const t of added) {
    const n = left.get(t) || 0;
    if (n > 0) left.set(t, n - 1);
    else titles.push(t);
  }
  return { added: titles.length, titles };
}

// ---------- Pull requests ----------
const cache = new Map();
const prDetails = new Map(); // merged PRs never change: cache their merge time and test count for good

async function mergeTime(repo, pr) {
  try {
    const acts = await pages(`/repositories/${repo}/pullrequests/${pr.id}/activity?pagelen=50`, 10);
    for (const a of acts) {
      if (a.update?.state === "MERGED" && a.update.date) return a.update.date;
    }
  } catch { /* fall back below */ }
  return pr.updated_on; // merging is normally a PR's last update
}

async function details(repo, pr) {
  const key = `${repo}#${pr.id}`;
  if (prDetails.has(key)) return prDetails.get(key);
  const [mergedAt, diff] = await Promise.all([
    mergeTime(repo, pr),
    bbFetch(`/repositories/${repo}/pullrequests/${pr.id}/diff`, { text: true }),
  ]);
  const { added, titles } = countNewTests(diff);
  const d = { mergedAt, testsAdded: added, testTitles: titles.slice(0, 50) };
  prDetails.set(key, d);
  return d;
}

/**
 * All PRs merged into the configured branch during [start, end) ("YYYY-MM-DD", end exclusive),
 * across the configured repos. Returns [{ repo, id, title, url, authorId, authorName, mergedAt, testsAdded, testTitles }]
 */
export async function fetchMergedPRs({ start, end, refresh = false }) {
  if (!bitbucketEnabled()) return [];
  const c = cfg();
  const key = `prs|${c.repos.join(",")}|${c.branch}|${start}|${end}`;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < c.cacheMs) return hit.value;

  const perRepo = await Promise.all(c.repos.map(async (repo) => {
    // A PR merged in the period was last updated on or after its merge, so this finds them all.
    const q = `state = "MERGED" AND destination.branch.name = "${c.branch}" AND updated_on >= ${start}T00:00:00Z`;
    const fields = "next,values.id,values.title,values.updated_on,values.author.account_id,values.author.display_name,values.links.html.href";
    const prs = await pages(`/repositories/${repo}/pullrequests?state=MERGED&pagelen=50&q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}`);
    const withDetails = await pool(prs, 5, async (pr) => ({ pr, d: await details(repo, pr) }));
    return withDetails
      .filter(({ d }) => { const day = String(d.mergedAt).slice(0, 10); return day >= start && day < end; })
      .map(({ pr, d }) => ({
        repo,
        id: pr.id,
        title: pr.title || "",
        url: pr.links?.html?.href || `https://bitbucket.org/${repo}/pull-requests/${pr.id}`,
        authorId: pr.author?.account_id || "",
        authorName: pr.author?.display_name || "",
        mergedAt: d.mergedAt,
        testsAdded: d.testsAdded,
        testTitles: d.testTitles,
      }));
  }));
  const value = perRepo.flat().sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function testBitbucket() {
  if (!bitbucketEnabled()) return { ok: true, message: "Bitbucket: not configured (scripts and PRs are manual)" };
  const c = cfg();
  const results = await Promise.allSettled(c.repos.map((r) => bbFetch(`/repositories/${r}?fields=full_name`)));
  const lines = results.map((r, i) => (r.status === "fulfilled" ? `${c.repos[i]}: connected` : `${c.repos[i]}: FAILED (${r.reason?.message || r.reason})`));
  return { ok: results.every((r) => r.status === "fulfilled"), message: `Bitbucket ${lines.join(" · ")}` };
}
