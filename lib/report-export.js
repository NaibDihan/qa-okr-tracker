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

// One report "subject": an engineer (individual report) or the team (team report).
// The KR rows have the same shape either way; the team has no names, comments or tickets.
function subjects(report) {
  if (report.kind === "team") {
    const t = report.team;
    return [{
      team: true,
      title: "Team Report",
      sheetName: "Team Report",
      lines: [
        `${t.memberCount} member${t.memberCount === 1 ? "" : "s"}: ${t.members.join(", ")}`,
        "Each value is the average of the members' own values. Status compares the team average with the average of the members' targets.",
      ],
      warnings: t.warnings || [],
      rows: t.rows,
    }];
  }
  return report.engineers.map((res) => ({
    team: false,
    title: `QA OKR Report: ${res.engineer.name}`,
    sheetName: res.engineer.name,
    name: res.engineer.name,
    active: res.engineer.active,
    lines: [`Projects: ${res.projects.join(", ") || "none"}`],
    warnings: res.warnings,
    rows: res.rows,
    details: res.details,
  }));
}

// ---------- XLSX ----------
export function buildXlsxReport(report) {
  const { period } = report;
  const isQuarter = period.mode === "quarter";
  const multiMonth = period.months.length > 1;
  const sheets = [];
  const demo = report.jiraMode === "demo" ? "  ·  DEMO Jira data" : "";

  for (const sub of subjects(report)) {
    const monthCols = multiMonth ? period.months.map((m) => m.label) : ["Value"];
    const header = [
      isQuarter ? "Quarter" : "Period",
      ...(sub.team ? [] : ["Engineer Name"]),
      "Category", "Objective", "Key Result", "Data Source", "Direction",
      ...(isQuarter ? ["Baseline", "Target"] : []),
      ...monthCols,
      ...(multiMonth ? [isQuarter ? "Quarter Total" : "Period Total"] : []),
      "Calculation",
      ...(isQuarter ? ["% to Target", "Status"] : []),
      ...(sub.team ? [] : ["Notes / Comments", "Engineer Status"]),
    ];
    const rows = [
      [{ v: sub.title, s: "title" }],
      [{ v: `${period.label}  ·  generated ${report.generatedAt.slice(0, 10)}${demo}`, s: "subtitle" }],
      ...sub.lines.map((l) => [{ v: l, s: "subtitle" }]),
      ...(sub.warnings.length ? [[{ v: sub.warnings.join("  |  "), s: "subtitle" }]] : []),
      [],
    ];
    const headerRow = rows.length;
    rows.push(header.map((h) => ({ v: h, s: "header" })));
    sub.rows.forEach((r, i) => {
      rows.push([
        { v: period.label, s: "text" },
        ...(sub.team ? [] : [{ v: i === 0 ? sub.name : "", s: "text" }]),
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
              r.progress === null || r.progress === undefined ? { v: "—", s: "center" } : { v: Math.round(r.progress * 100) / 100, s: "ratio" },
              { v: statusText(r), s: STATUS_XLSX[r.status] || "statusMuted" },
            ]
          : []),
        ...(sub.team ? [] : [
          { v: commentText(r), s: "text" },
          { v: i === 0 ? (sub.active ? "Active" : "Inactive") : "", s: "center" },
        ]),
      ]);
    });
    const widths = [
      11,
      ...(sub.team ? [] : [20]),
      10, 30, 26, 26, 13,
      ...(isQuarter ? [10, 10] : []),
      ...monthCols.map(() => 11),
      ...(multiMonth ? [13] : []),
      24,
      ...(isQuarter ? [10, 16] : []),
      ...(sub.team ? [] : [44, 12]),
    ];
    sheets.push({ name: sub.sheetName, columns: widths, rows, freezeRow: headerRow + 1, rowHeights: { [headerRow]: 30 } });

    if (sub.team) continue;
    // Detail sheet (individual reports only): the Jira tickets behind the numbers
    const det = [
      [{ v: `Jira details: ${sub.name}`, s: "title" }],
      [],
      ["Bugs reported", "Created", "Status", "Rejected?", "", "QA cycle tickets", "Closed", "Hours", "", "Merged PR", "Title", "Merged", "New tests"]
        .map((h, i) => (i === 4 || i === 8 ? null : { v: h, s: "header" })),
    ];
    const prs = sub.details.prs || [];
    const n = Math.max(sub.details.bugs.length, sub.details.cycle.length, prs.length);
    for (let i = 0; i < n; i++) {
      const b = sub.details.bugs[i], c = sub.details.cycle[i], p = prs[i];
      det.push([
        b ? { v: b.key, s: "text" } : null, b ? { v: b.created, s: "text" } : null, b ? { v: b.status, s: "text" } : null,
        b ? { v: b.rejected ? "Yes" : "No", s: "center" } : null, null,
        c ? { v: c.key, s: "text" } : null, c ? { v: c.closed, s: "text" } : null, c ? { v: c.hours, s: "hours" } : null, null,
        p ? { v: `#${p.id}`, s: "text" } : null, p ? { v: p.title, s: "text" } : null, p ? { v: p.merged, s: "text" } : null, p ? { v: p.tests, s: "int" } : null,
      ]);
    }
    sheets.push({ name: `${sub.name.slice(0, 22)} details`, columns: [16, 12, 14, 10, 3, 18, 12, 10, 3, 11, 40, 12, 10], rows: det, freezeRow: 3 });
  }
  return buildXlsx(sheets);
}

// ---------- PDF ----------
export function buildPdfReport(report) {
  const { period } = report;
  const isQuarter = period.mode === "quarter";
  const multiMonth = period.months.length > 1;
  const doc = new PdfDoc({ width: 842, height: 595, margin: 32 });
  const fullW = doc.W - doc.margin * 2;
  const x = doc.margin;
  const demo = report.jiraMode === "demo" ? "   ·   DEMO Jira data (Jira not connected)" : "";

  subjects(report).forEach((sub, idx) => {
    if (idx > 0) doc.addPage();
    doc.text(x, doc.y, sub.title, { size: 16, bold: true });
    doc.y += 22;
    doc.text(x, doc.y, `${period.label}   ·   Generated ${report.generatedAt.slice(0, 10)}${demo}`, { size: 9, color: "#64748b" });
    doc.y += 15;
    for (const l of sub.lines) {
      for (const ln of doc.wrap(l, fullW, 8.5)) {
        doc.text(x, doc.y, ln, { size: 8.5, color: "#334155" });
        doc.y += 12;
      }
    }
    for (const w of sub.warnings) {
      doc.text(x, doc.y, `! ${w}`, { size: 8, color: "#b45309" });
      doc.y += 12;
    }
    doc.y += 6;

    const monthTitles = multiMonth ? period.months.map((m) => m.label) : ["Value"];
    const fixed = [
      { title: "Key Result", width: sub.team ? 190 : 140 },
      { title: "Direction", width: 54, align: "center" },
      ...(isQuarter ? [{ title: "Baseline", width: 44, align: "right" }, { title: "Target", width: 44, align: "right" }] : []),
    ];
    const tail = [
      ...(multiMonth ? [{ title: isQuarter ? "Quarter" : "Total", width: 52, align: "right" }] : []),
      ...(isQuarter ? [{ title: "% to Target", width: 42, align: "right" }, { title: "Status", width: 62, align: "center" }] : []),
    ];
    const used = [...fixed, ...tail].reduce((a, c) => a + c.width, 0);
    let columns;
    if (sub.team) {
      // No notes column: months share the remaining width.
      const monthW = Math.min(90, (fullW - used) / monthTitles.length);
      columns = [...fixed, ...monthTitles.map((t) => ({ title: t, width: monthW, align: "right" })), ...tail];
    } else {
      let monthW = 48;
      let notesW = fullW - used - monthW * monthTitles.length;
      if (notesW < 110) {
        monthW = Math.max(34, (fullW - used - 110) / monthTitles.length);
        notesW = fullW - used - monthW * monthTitles.length;
      }
      columns = [...fixed, ...monthTitles.map((t) => ({ title: t, width: monthW, align: "right" })), ...tail, { title: "Notes / Comments", width: notesW }];
    }

    const rows = [];
    let cat = null;
    for (const r of sub.rows) {
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
          ...(sub.team ? [] : [{ text: commentText(r), color: "#334155" }]),
        ],
      });
    }
    doc.table({ columns, rows });
  });

  return doc.toBuffer({ footer: `QA OKR Tracker   ·   ${period.label}` });
}
