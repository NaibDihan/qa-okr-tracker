// Minimal PDF writer (no dependencies): Helvetica text, rectangles, lines and simple tables.
import zlib from "node:zlib";

// Standard Helvetica / Helvetica-Bold advance widths for ASCII 32..126 (1/1000 em).
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const WINANSI_EXTRA = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 };
const REPLACE = { "→": "->", "≥": ">=", "≤": "<=", "−": "-", "✓": "v" };

function encode(str) {
  const bytes = [];
  for (const ch of String(str)) {
    if (REPLACE[ch]) { for (const c of REPLACE[ch]) bytes.push(c.charCodeAt(0)); continue; }
    const code = ch.codePointAt(0);
    if (code >= 32 && code < 127) bytes.push(code);
    else if (WINANSI_EXTRA[ch]) bytes.push(WINANSI_EXTRA[ch]);
    else if (code >= 0xa0 && code <= 0xff) bytes.push(code);
    else if (code === 9) bytes.push(32);
    else bytes.push(63); // "?"
  }
  return bytes;
}

function widthOf(bytes, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const b of bytes) w += b >= 32 && b < 127 ? table[b - 32] : b === 0x92 || b === 0x91 ? 222 : 556;
  return (w / 1000) * size;
}

const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
const rgb = (c) => {
  const h = c.replace("#", "");
  return [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
};

export class PdfDoc {
  constructor({ width = 842, height = 595, margin = 32 } = {}) {
    this.W = width; this.H = height; this.margin = margin;
    this.pages = [];
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.margin;
    return this;
  }

  textWidth(str, size = 9, bold = false) { return widthOf(encode(str), size, bold); }

  text(x, y, str, { size = 9, bold = false, color = "#0f172a" } = {}) {
    const bytes = encode(str);
    this.ops.push(`BT ${rgb(color)} rg /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${(this.H - y - size).toFixed(2)} Td <${hex(bytes)}> Tj ET`);
  }

  rect(x, y, w, h, { fill, stroke, lineWidth = 0.5 } = {}) {
    const r = `${x.toFixed(2)} ${(this.H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`;
    if (fill && stroke) this.ops.push(`${rgb(fill)} rg ${rgb(stroke)} RG ${lineWidth} w ${r} B`);
    else if (fill) this.ops.push(`${rgb(fill)} rg ${r} f`);
    else if (stroke) this.ops.push(`${rgb(stroke)} RG ${lineWidth} w ${r} S`);
  }

  line(x1, y1, x2, y2, { color = "#d5dce4", lineWidth = 0.5 } = {}) {
    this.ops.push(`${rgb(color)} RG ${lineWidth} w ${x1.toFixed(2)} ${(this.H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.H - y2).toFixed(2)} l S`);
  }

  wrap(str, maxWidth, size = 9, bold = false) {
    const out = [];
    for (const para of String(str ?? "").split(/\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(""); continue; }
      let line = "";
      for (let word of words) {
        // Hard-break words longer than the column.
        while (this.textWidth(word, size, bold) > maxWidth && word.length > 1) {
          let cut = word.length - 1;
          while (cut > 1 && this.textWidth(word.slice(0, cut), size, bold) > maxWidth) cut--;
          if (line) { out.push(line); line = ""; }
          out.push(word.slice(0, cut));
          word = word.slice(cut);
        }
        const candidate = line ? `${line} ${word}` : word;
        if (this.textWidth(candidate, size, bold) <= maxWidth) line = candidate;
        else { out.push(line); line = word; }
      }
      if (line) out.push(line);
    }
    return out;
  }

  ensureSpace(h) {
    if (this.y + h > this.H - this.margin - 14) { this.addPage(); return true; }
    return false;
  }

  /**
   * columns: [{ title, width, align }]
   * rows: [{ cells: [{ text, bold, color, fill, align }], fill, group }]
   */
  table({ columns, rows, x = this.margin, size = 7.5, pad = 4, headerFill = "#1e3a5f" }) {
    const lineH = size * 1.25;
    const totalW = columns.reduce((a, c) => a + c.width, 0);

    const drawHeader = () => {
      const lines = columns.map((c) => this.wrap(c.title, c.width - pad * 2, size, true));
      const h = Math.max(...lines.map((l) => l.length)) * lineH + pad * 2;
      this.rect(x, this.y, totalW, h, { fill: headerFill });
      let cx = x;
      columns.forEach((c, i) => {
        lines[i].forEach((ln, li) => {
          const tw = this.textWidth(ln, size, true);
          const tx = c.align === "right" ? cx + c.width - pad - tw : c.align === "center" ? cx + (c.width - tw) / 2 : cx + pad;
          this.text(tx, this.y + pad + li * lineH, ln, { size, bold: true, color: "#ffffff" });
        });
        cx += c.width;
      });
      this.y += h;
    };

    drawHeader();
    for (const row of rows) {
      if (row.group) {
        const h = lineH + pad * 2;
        if (this.ensureSpace(h * 2)) drawHeader();
        this.rect(x, this.y, totalW, h, { fill: "#f1f5f9", stroke: "#d5dce4" });
        this.text(x + pad, this.y + pad, row.group, { size, bold: true, color: "#334155" });
        this.y += h;
        continue;
      }
      const cellLines = row.cells.map((cell, i) => this.wrap(cell?.text ?? "", columns[i].width - pad * 2, size, !!cell?.bold));
      const h = Math.max(1, ...cellLines.map((l) => l.length)) * lineH + pad * 2;
      if (this.ensureSpace(h)) drawHeader();
      if (row.fill) this.rect(x, this.y, totalW, h, { fill: row.fill });
      let cx = x;
      row.cells.forEach((cell, i) => {
        const c = columns[i];
        if (cell?.fill) this.rect(cx, this.y, c.width, h, { fill: cell.fill });
        const align = cell?.align || c.align;
        cellLines[i].forEach((ln, li) => {
          const tw = this.textWidth(ln, size, !!cell?.bold);
          const tx = align === "right" ? cx + c.width - pad - tw : align === "center" ? cx + (c.width - tw) / 2 : cx + pad;
          this.text(tx, this.y + pad + li * lineH, ln, { size, bold: !!cell?.bold, color: cell?.color || "#0f172a" });
        });
        cx += c.width;
      });
      // grid
      this.rect(x, this.y, totalW, h, { stroke: "#d5dce4" });
      let gx = x;
      for (const c of columns.slice(0, -1)) { gx += c.width; this.line(gx, this.y, gx, this.y + h); }
      this.y += h;
    }
    return this.y;
  }

  toBuffer({ footer } = {}) {
    // Page footers
    this.pages.forEach((ops, i) => {
      const saved = this.ops;
      this.ops = ops;
      const label = `${footer ? footer + "   ·   " : ""}Page ${i + 1} of ${this.pages.length}`;
      this.text(this.W - this.margin - this.textWidth(label, 7), this.H - this.margin + 6, label, { size: 7, color: "#64748b" });
      this.ops = saved;
    });

    const objects = [];
    const add = (content) => { objects.push(content); return objects.length; };
    const catalogId = add(null);
    const pagesId = add(null);
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds = [];
    for (const ops of this.pages) {
      const stream = zlib.deflateSync(Buffer.from(ops.join("\n"), "latin1"));
      const contentId = add({ dict: `<< /Length ${stream.length} /Filter /FlateDecode >>`, stream });
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`));
    }
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

    const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
    const offsets = [];
    let pos = parts[0].length;
    objects.forEach((obj, i) => {
      offsets.push(pos);
      let buf;
      if (typeof obj === "string") buf = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, "latin1");
      else buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${obj.dict}\nstream\n`, "latin1"), obj.stream, Buffer.from("\nendstream\nendobj\n", "latin1")]);
      parts.push(buf);
      pos += buf.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
    return Buffer.concat(parts);
  }
}
