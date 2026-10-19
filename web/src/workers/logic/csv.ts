import type { CsvPreview } from "../protocol";

/** RFC-4180 style parser (quotes, escaped quotes, CRLF, embedded newlines, BOM). Mirrors the server's importer. */
export function parseCsv(input: string, cancelled: () => boolean = () => false): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = input.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    if ((i & 0xffff) === 0 && cancelled()) throw new Error("cancelled");
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s().-]{7,20}$/;

/** Parse and validate a contacts file before upload: counts, first rows and per-row problems (header is row 1). */
export function previewContactsCsv(text: string, maxRows: number, cancelled: () => boolean = () => false): CsvPreview {
  const rows = parseCsv(text, cancelled);
  const headers = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const idx = (n: string) => headers.indexOf(n);
  const recognised = { name: idx("name") >= 0, email: idx("email") >= 0, phone: idx("phone") >= 0, tags: idx("tags") >= 0 };
  const errors: CsvPreview["errors"] = [];
  let valid = 0;
  const body = rows.slice(1);
  body.forEach((cells, i) => {
    if ((i & 0x3ff) === 0 && cancelled()) throw new Error("cancelled");
    const get = (n: string) => (idx(n) >= 0 ? (cells[idx(n)] ?? "").trim() : "");
    const email = get("email");
    const phone = get("phone");
    if (!email && !phone && !get("name")) return void errors.push({ row: i + 2, error: "Row has no name, email or phone" });
    if (email && !EMAIL.test(email)) return void errors.push({ row: i + 2, error: `"${email}" is not a valid email` });
    if (phone && !PHONE.test(phone)) return void errors.push({ row: i + 2, error: `"${phone}" does not look like a phone number` });
    valid++;
  });
  if (!recognised.name && !recognised.email && !recognised.phone && !recognised.tags && rows.length) errors.unshift({ row: 1, error: "Header needs at least one of: name, email, phone, tags" });
  return { headers, total: body.length, valid, preview: body.slice(0, maxRows), errors: errors.slice(0, 200), recognised };
}
