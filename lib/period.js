// Period handling: month, quarter or custom date range.
// All dates are plain "YYYY-MM-DD" strings; `end` is exclusive.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n) => String(n).padStart(2, "0");

export function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextMonthStart(key) {
  let [y, m] = key.split("-").map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${pad(m)}-01`;
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function quarterOfMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

export function quarterMonths(quarterKey) {
  const [y, q] = quarterKey.split("-Q").map(Number);
  const first = (q - 1) * 3 + 1;
  return [0, 1, 2].map((i) => `${y}-${pad(first + i)}`);
}

export function previousQuarter(quarterKey) {
  let [y, q] = quarterKey.split("-Q").map(Number);
  q -= 1;
  if (q === 0) { q = 4; y -= 1; }
  return `${y}-Q${q}`;
}

function monthsBetween(start, endExclusive) {
  const months = [];
  let key = start.slice(0, 7);
  while (`${key}-01` < endExclusive) {
    months.push(key);
    key = nextMonthStart(key).slice(0, 7);
  }
  return months;
}

/**
 * Parse period query params into a period object.
 * mode=month&value=2026-09 | mode=quarter&value=2026-Q3 | mode=custom&from=2026-07-01&to=2026-09-30
 */
export function parsePeriod(params) {
  const mode = params.mode || "quarter";
  let start, end, label, quarterKey = null;

  if (mode === "month") {
    const value = params.value;
    if (!/^\d{4}-\d{2}$/.test(value || "")) throw new Error("Month must look like 2026-09");
    start = `${value}-01`;
    end = nextMonthStart(value);
    label = monthLabel(value);
  } else if (mode === "quarter") {
    const value = params.value;
    if (!/^\d{4}-Q[1-4]$/.test(value || "")) throw new Error("Quarter must look like 2026-Q3");
    const months = quarterMonths(value);
    start = `${months[0]}-01`;
    end = nextMonthStart(months[2]);
    const [y, q] = value.split("-");
    label = `${q} ${y}`;
    quarterKey = value;
  } else if (mode === "custom") {
    const { from, to } = params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
      throw new Error("Custom range needs from and to dates");
    }
    if (to < from) throw new Error("The end date is before the start date");
    start = from;
    end = addDays(to, 1);
    label = `${from} → ${to}`;
  } else {
    throw new Error(`Unknown period mode: ${mode}`);
  }

  const months = monthsBetween(start, end);
  return {
    mode,
    start,
    end,
    label,
    quarterKey,
    months: months.map((key) => ({ key, label: monthLabel(key) })),
    // A period is complete once its last day has passed.
    complete: end <= todayStr(),
  };
}
