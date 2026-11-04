# QA OKR Tracker

A small web app that tracks QA engineers' OKRs. It pulls bug and QA-cycle data from Jira Cloud and collects the rest through a monthly entry form.

- **No install step.** Plain Node.js, no packages. There is nothing to `npm install`.
- **Runs locally** at http://localhost:3000 with data in one file, `data/okr.json`.
- **Runs on Vercel** with data in a free Upstash Redis database (see below).
- **Light and dark mode.** Toggle at the bottom of the sidebar.

## Requirements

- **Node.js 18.17 or newer** (Node 20 works). Check with `node -v`.

## Run it

```bash
cd qa-okr-tracker

# 1. Optional: load sample data to try things out
npm run seed:demo

# 2. Start the app
npm start
```

Open **http://localhost:3000**. Stop it with `Ctrl + C`.

Without Jira credentials the app runs in **demo mode** and generates sample Jira numbers. Everything else, including entries, targets and reports, works normally.

To clear the demo data later, stop the app and delete the `data` folder, or run `npm run seed:demo -- --force` to reset it to the samples.

## Connect Jira Cloud

1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens. Ideally use an account that can read all the QA projects.
2. Copy `.env.example` to `.env` and fill in:
   ```
   JIRA_BASE_URL=https://asthait.atlassian.net
   JIRA_EMAIL=you@yourcompany.com
   JIRA_API_TOKEN=your-token
   ```
3. Restart the app (`Ctrl + C`, then `npm start`).

**Several Jira sites (for example your company's and a client's):** list them in `JIRA_BASE_URL` separated by commas, e.g. `JIRA_BASE_URL=https://asthait.atlassian.net,https://emctech.atlassian.net`. One Atlassian account is used for all of them (an API token works on every site that account can open). The people and project pickers show which site each comes from, and a project can be assigned from any site. Projects saved before you added a second site belong to the first site in the list. If a site doesn't let your account list people, Setup shows a warning for that site and still lists the others.
4. Go to **Setup** and press **Test connection**.
5. Press **Add QA engineer** and pick people from the searchable list of everyone in your Jira.
6. For each engineer, press **+ Project** and pick their projects from the searchable list of your Jira projects.

The API account needs **Browse projects** on the QA projects and the **Browse users and groups** global permission (so it can list people).

The `.env` file holds your token. Don't commit or share it.

## Deploy on Vercel

Vercel can't save files (its disk is read-only and reset between requests), so the data goes in a small cloud database instead. Upstash Redis has a free tier and Vercel connects it for you.

1. **Push the code to GitHub** and import the repo in Vercel. `vercel.json` already tells Vercel how to run it, so no build settings are needed.
2. **Add the database:** in your Vercel project open **Storage → Create Database → Upstash for Redis** (from the Marketplace), choose the free plan, and **connect it to this project**. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
3. **Environment variables** (Project → Settings → Environment Variables):
   - `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
   - `APP_PASSWORD`: a team password. The site is public on the internet, so set this. Without it, anyone with the link can see your Jira data and change entries.
4. **Redeploy** (Deployments → ⋯ → Redeploy). Environment changes only apply to new deployments.
5. Open the site, then **Setup → Test connection**. The Setup page also shows "Data storage: Upstash Redis (cloud)".

**Moving your local setup to Vercel (optional):** copy `KV_REST_API_URL` and `KV_REST_API_TOKEN` from Vercel (Storage → your database → `.env.local` tab) into your local `.env`, then run `npm run upload-data`. It copies engineers, projects, entries, comments and targets from `data/okr.json` to the cloud database. It refuses if the cloud already has engineers; `npm run upload-data -- --force` replaces the cloud data.

Keep `data/` in `.gitignore`. Committing it wouldn't help: Vercel can't write to it, so the site would show a frozen copy.

## How each KR is calculated

| KR | Source | Formula |
|---|---|---|
| Defect Rejection Rate | Jira | Bugs with status **Won’t Do** ÷ Bugs reported |
| Defect Detection Efficiency | Jira + Manual | (Bugs reported − Won’t Do bugs) ÷ Test cases executed |
| Production Defect Leakage Rate | Manual + Jira | Production bugs ÷ Bugs reported |
| Average QA Cycle Time | Jira | Average hours from the last move into **In QA** to **Closed** |
| On-Time Release Sign-off Rate | Manual | Sign-offs provided ÷ Releases done |
| Automated Test Scripts Added | Manual | Sum |
| PR Merged (Automation) | Manual | Sum |

**Jira scope:**
- "Bugs reported" means issues of type Bug whose **reporter** is the engineer, in the engineer's assigned projects, counted in the month they were **created**.
- QA cycle time covers **all issue types** in the engineer's projects, counted in the month they were **Closed**. Each move into In QA restarts the timer. Any move to a status other than Closed resets it. A ticket counts only if it goes In QA → Closed directly.
- Status names are set by environment variables (see `.env.example`). Case and apostrophe style don't matter.

**Periods and status:**
- **Month** and **custom range** views show values only.
- **Quarter** view compares the quarter's result with the target. Rates are recalculated from the quarter's totals, and counts are summed over the three months.
- Status is given only after the quarter has ended and all three months have manual entries.

| KR | Target unit | On Track | Exceeded | At Risk |
|---|---|---|---|---|
| Defect Rejection Rate | % | ≤ target | (none) | > target |
| Defect Detection Efficiency | (no target, trend only) | | | |
| Production Defect Leakage Rate | % | ≤ target | (none) | > target |
| Average QA Cycle Time | hours | ≤ target | (none) | > target |
| On-Time Release Sign-off Rate | % | ≥ target | (none) | < target |
| Automated Test Scripts Added | count | = target | > target | < target |
| PR Merged (Automation) | count | = target | > target | < target |

## Pages

- **Dashboard:** pick a QA engineer and a period to see all KRs, monthly values, status, comments, and the Jira tickets behind the numbers.
- **Monthly Entry:** each QA enters their numbers for a month, with a comment field for every KR.
- **Targets:** baseline and target per engineer per quarter, with % / hours inputs. You can copy targets from the previous quarter or apply them to everyone.
- **Reports:** pick one or more engineers and a period. The report shows on screen and downloads as **Excel** or **PDF**. Team reports include a team summary.
- **Setup:** pick QA engineers and their projects from searchable Jira lists, and check the Jira connection.

## Project layout

```
server.js              Local server (npm start)
api/index.js           Vercel entry point
vercel.json            Vercel settings
lib/app.js             API routes, optional password, static files
lib/db.js              Data functions
lib/store.js           Storage: local JSON file or Upstash Redis
lib/jira.js            Jira Cloud client, QA-cycle rule, demo data
lib/krs.js             KR definitions, calculations, status rules
lib/period.js          Month / quarter / custom ranges
lib/report-export.js   Excel + PDF report layouts
lib/xlsx.js, pdf.js, zip.js   Dependency-free file writers
public/                Frontend (index.html, app.js, styles.css)
scripts/seed-demo.js   Sample data (local file only)
scripts/upload-data.js Copy local data to the cloud database
data/okr.json          Local data (created on first run). Back this file up.
```

## Later: Bitbucket

Scripts added and PRs merged are manual for now. To automate them, add a Bitbucket client next to `lib/jira.js` and fill `scripts_added` and `prs_merged` from it in `computeEngineer` in `lib/krs.js`. The rest of the app stays the same.
