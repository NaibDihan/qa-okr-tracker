// Turns a report object (see server.js buildReport) into .xlsx and .pdf files.
import { buildXlsx } from "./xlsx.js";
import { PdfDoc } from "./pdf.js";
import { DIRECTION_LABEL, STATUS_LABEL, KR_BY_KEY } from "./krs.js";

const STATUS_XLSX = { exceeded: "exceeded", "on-track": "ontrack", "at-risk": "atrisk" };
const STATUS_PDF = {
  exceeded: { fill: "#dbeafe", color: "#1e40af" },
  "on-track": { fill: "#dcfce7", color: "#166534" },
  "at-risk": { fill: "#fef3c7", color: "#92400e" },
};

// Numeric cell for xlsx, typed by KR unit. Percentages are stored as fractions.
function numCell(unit, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return { v: "—", s: "center" };
  if (unit === "%") return { v: v / 100, s: "pct" };
  if (unit === "hours") return { v: Math.round(v * 100) / 100, s: "hours" };
  return { v, s: "int" };
}

const fmtTarget = (unit, v) => {
  if (v === null || v === undefined) return "—";
  if (unit === "%") return `${Number(v).toFixed(1)}%`;
  if (unit === "hours") return `${Number(v).toFixed(2)} h`;
  return String(v);
};

const commentText = (row) => row.comments.map((c) => `${c.label.split(" ")[0]}: ${c.text}`).join("\n");
const statusText = (row) => (row.status ? STATUS_LABEL[row.status] + (row.status === "pending" && row.statusNote ? ` (${row.statusNote})` : "") : "");
const progressText = (row) => (row.progress === null || row.progress === undefined ? "—" : row.progress.toFixed(2));

// ---------- XLSX ----------
export function buildXlsxReport(report) {
  const { period, engineers, team } = report;
  const isQuarter = period.mode === "quarter";
  const multiMonth = period.months.length > 1;
  const sheets = [];

  if (team) {
    const header = ["Category", "Key Result", "Direction", ...engineers.map((e) => e.engineer.name), "Team"];
    const rows = [
      [{ v: "QA OKR Report: Team Summary", s: "title" }],
      [{ v: `${period.label}  ·  generated ${report.generatedAt.slice(0, 10)}${report.jiraMode === "demo" ? "  ·  DEMO Jira data" : ""}`, s: "subtitle" }],
      [],
      header.map((h) => ({ v: h, s: "header" })),
    ];
    for (const r of team.rows) {
      rows.push([
        { v: r.category, s: "text" },
        { v: r.name, s: "bold" },
        { v: DIRECTION_LABEL[r.direction], s: "center" },
        ...r.perEngineer.map((p) => numCell(r.unit, p.value)),
        { ...numCell(r.unit, r.total.value), s: numCell(r.unit, r.total.value).s },
      ]);
    }
    if (isQuarter) {
      rows.push([]);
      rows.push(["Category", "Key Result", "Quarter status", ...engineers.map((e) => e.engineer.name)].map((h) => ({ v: h, s: "header" })));
      for (const r of team.rows) {
        rows.push([
          { v: r.category, s: "text" }, { v: r.name, s: "bold" }, { v: "", s: "text" },
          ...r.perEngineer.map((p) => ({ v: p.status ? STATUS_LABEL[p.status] : "", s: STATUS_XLSX[p.status] || "statusMuted" })),
        ]);
      }
    }
    sheets.push({ name: "Team Summary", columns: [12, 32, 14, ...engineers.map(() => 18), 14], rows, freezeRow: 4, rowHeights: { 3: 30 } });
  }

  for (const res of engineers) {
    const monthCols = multiMonth ? period.months.map((m) => m.label) : ["Value"];
    const header = [
      isQuarter ? "Quarter" : "Period", "Engineer Name", "Category", "Objective", "Key Result", "Data Source", "Direction",
      ...(isQuarter ? ["Baseline", "Target"] : []),
      ...monthCols,
      ...(multiMonth ? [isQuarter ? "Quarter Total" : "Period Total"] : []),
      "Calculation",
      ...(isQuarter ? ["% to Target", "Status"] : []),
      "Notes / Comments", "Engineer Status",
    ];
    const rows = [
      [{ v: `QA OKR Report: ${res.engineer.name}`, s: "title" }],
      [{ v: `${period.label}  ·  Projects: ${res.projects.join(", ") || "none"}${res.jiraMode === "demo" ? "  ·  DEMO Jira data" : ""}`, s: "subtitle" }],
      ...(res.warnings.length ? [[{ v: res.warnings.join("  |  "), s: "subtitle" }]] : []),
      [],
    ];
    const headerRow = rows.length;
    rows.push(header.map((h) => ({ v: h, s: "header" })));
    res.rows.forEach((r, i) => {
      rows.push([
        { v: period.label, s: "text" },
        { v: i === 0 ? res.engineer.name : "", s: "text" },
        { v: r.category, s: "bold" },
        { v: r.objective, s: "text" },
        { v: r.name, s: "bold" },
        { v: r.source, s: "muted" },
        { v: DIRECTION_LABEL[r.direction], s: "center" },
        ...(isQuarter
          ? [
              r.direction === "monitor" || r.baseline === null ? { v: "N/A", s: "statusMuted" } : numCell(r.unit, r.baseline),
              r.direction === "monitor" || r.target === null ? { v: "N/A", s: "statusMuted" } : numCell(r.unit, r.target),
            ]
          : []),
        ...r.months.map((m) => numCell(r.unit, m.value)),
        ...(multiMonth ? [numCell(r.unit, r.total.value)] : []),
        { v: r.total.inputs || "", s: "muted" },
        ...(isQuarter
          ? [
              r.progress === null ? { v: "—", s: "center" } : { v: Math.round(r.progress * 100) / 100, s: "ratio" },
              { v: statusText(r), s: STATUS_XLSX[r.status] || "statusMuted" },
            ]
          : []),
        { v: commentText(r), s: "text" },
        { v: i === 0 ? (res.engineer.active ? "Active" : "Inactive") : "", s: "center" },
      ]);
    });
    const widths = [
      11, 20, 10, 30, 26, 26, 13,
      ...(isQuarter ? [10, 10] : []),
      ...monthCols.map(() => 11),
      ...(multiMonth ? [13] : []),
      24,
      ...(isQuarter ? [10, 16] : []),
      44, 12,
    ];
    sheets.push({ name: res.engineer.name, columns: widths, rows, freezeRow: headerRow + 1, rowHeights: { [headerRow]: 30 } });

    // Detail sheet: the Jira tickets behind the numbers
    const det = [
      [{ v: `Jira details: ${res.engineer.name}`, s: "title" }],
      [],
      ["Bugs reported", "Created", "Status", "Rejected?", "", "QA cycle tickets", "Closed", "Hours"].map((h, i) => (i === 4 ? null : { v: h, s: "header" })),
    ];
    const n = Math.max(res.details.bugs.length, res.details.cycle.length);
    for (let i = 0; i < n; i++) {
      const b = res.details.bugs[i], c = res.details.cycle[i];
      det.push([
        b ? { v: b.key, s: "text" } : null, b ? { v: b.created, s: "text" } : null, b ? { v: b.status, s: "text" } : null,
        b ? { v: b.rejected ? "Yes" : "No", s: "center" } : null, null,
        c ? { v: c.key, s: "text" } : null, c ? { v: c.closed, s: "text" } : null, c ? { v: c.hours, s: "hours" } : null,
      ]);
    }
    sheets.push({ name: `${res.engineer.name.slice(0, 22)} details`, columns: [16, 12, 14, 10, 3, 18, 12, 10], rows: det, freezeRow: 3 });
  }
  return buildXlsx(sheets);
}

// ---------- PDF ----------
export function buildPdfReport(report) {
  const { period, engineers, team } = report;
  const isQuarter = period.mode === "quarter";
  const multiMonth = period.months.length > 1;
  const doc = new PdfDoc({ width: 842, height: 595, margin: 32 });
  const fullW = doc.W - doc.margin * 2;
  const x = doc.margin;

  // Title block
  doc.text(x, doc.y, team ? "QA OKR Report: Team" : `QA OKR Report: ${engineers[0].engineer.name}`, { size: 16, bold: true });
  doc.y += 22;
  doc.text(x, doc.y, `${period.label}   ·   Generated ${report.generatedAt.slice(0, 10)}${report.jiraMode === "demo" ? "   ·   DEMO Jira data (Jira not connected)" : ""}`, { size: 9, color: "#64748b" });
  doc.y += 20;

  if (team) {
    doc.text(x, doc.y, "Team summary", { size: 11, bold: true });
    doc.y += 16;
    const nameW = Math.max(60, Math.min(110, (fullW - 220 - 70) / engineers.length));
    const columns = [
      { title: "Key Result", width: 170 },
      { title: "Direction", width: 60, align: "center" },
      ...engineers.map((e) => ({ title: e.engineer.name, width: nameW, align: "right" })),
      { title: "Team", width: 70, align: "right" },
    ];
    const rows = [];
    let cat = null;
    for (const r of team.rows) {
      if (r.category !== cat) { cat = r.category; rows.push({ group: cat }); }
      rows.push({
        cells: [
          { text: r.name, bold: true },
          { text: DIRECTION_LABEL[r.direction], color: "#475569" },
          ...r.perEngineer.map((p) => {
            const st = STATUS_PDF[p.status];
            return { text: p.display, fill: st?.fill, color: st?.color };
          }),
          { text: r.total.display, bold: true },
        ],
      });
    }
    doc.table({ columns, rows });
    doc.y += 8;
    if (isQuarter) {
      doc.text(x, doc.y, "Cell colours show each engineer's quarter status:  blue = Exceeded,  green = On Track,  amber = At Risk.", { size: 7.5, color: "#64748b" });
      doc.y += 14;
    }
  }

  for (const res of engineers) {
    if (team || res !== engineers[0]) {
      doc.addPage();
    }
    if (team || res !== engineers[0]) {
      doc.text(x, doc.y, res.engineer.name, { size: 14, bold: true });
      doc.y += 19;
    }
    doc.text(x, doc.y, `Projects: ${res.projects.join(", ") || "none"}   ·   ${period.label}`, { size: 8.5, color: "#64748b" });
    doc.y += 14;
    for (const w of res.warnings) {
      doc.text(x, doc.y, `! ${w}`, { size: 8, color: "#b45309" });
      doc.y += 12;
    }
    doc.y += 4;

    const monthTitles = multiMonth ? period.months.map((m) => m.label) : ["Value"];
    const fixed = [
      { title: "Key Result", width: 140 },
      { title: "Direction", width: 54, align: "center" },
      ...(isQuarter ? [{ title: "Baseline", width: 44, align: "right" }, { title: "Target", width: 44, align: "right" }] : []),
    ];
    const tail = [
      ...(multiMonth ? [{ title: isQuarter ? "Quarter" : "Total", width: 52, align: "right" }] : []),
      ...(isQuarter ? [{ title: "% to Target", width: 42, align: "right" }, { title: "Status", width: 62, align: "center" }] : []),
    ];
    let used = [...fixed, ...tail].reduce((a, c) => a + c.width, 0);
    let monthW = 48;
    let notesW = fullW - used - monthW * monthTitles.length;
    if (notesW < 110) {
      monthW = Math.max(34, (fullW - used - 110) / monthTitles.length);
      notesW = fullW - used - monthW * monthTitles.length;
    }
    const columns = [
      ...fixed,
      ...monthTitles.map((t) => ({ title: t, width: monthW, align: "right" })),
      ...tail,
      { title: "Notes / Comments", width: notesW },
    ];

    const rows = [];
    let cat = null;
    for (const r of res.rows) {
      if (r.category !== cat) { cat = r.category; rows.push({ group: `${cat}: ${r.objective}` }); }
      const st = STATUS_PDF[r.status];
      const kr = KR_BY_KEY[r.key];
      rows.push({
        cells: [
          { text: `${r.name}\n${r.total.inputs || kr.formula}`, bold: false },
          { text: DIRECTION_LABEL[r.direction], color: "#475569" },
          ...(isQuarter
            ? [
                { text: r.direction === "monitor" ? "N/A" : fmtTarget(r.unit, r.baseline), color: "#475569" },
                { text: r.direction === "monitor" ? "N/A" : fmtTarget(r.unit, r.target), bold: true },
              ]
            : []),
          ...r.months.map((m) => ({ text: m.display })),
          ...(multiMonth ? [{ text: r.total.display, bold: true }] : []),
          ...(isQuarter
            ? [
                { text: progressText(r) },
                { text: statusText(r), fill: st?.fill, color: st?.color || "#64748b", bold: !!st },
              ]
            : []),
          { text: commentText(r), color: "#334155" },
        ],
      });
    }
    doc.table({ columns, rows });
  }

  return doc.toBuffer({ footer: `QA OKR Tracker   ·   ${period.label}` });
}
