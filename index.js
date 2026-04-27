import express from "express";
import multer from "multer";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import XLSX from "xlsx";
import textract from "textract";
import fs from "fs";
import path from "path";

const app = express();
const upload = multer({ dest: "uploads/" });

// Raw binary body parser for /extract-raw (large uploads supported).
const rawBodyParser = express.raw({
  type: "*/*",
  limit: "1tb",
});

// Health check
app.get("/", (req, res) => {
  res.json({ message: "📄 File Data Extractor microservice is running" });
});

// ──────────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────────

async function handleMultipartFile(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const fileBuffer = fs.readFileSync(filePath);
  try {
    const extractedText = await extractTextFromBuffer(fileBuffer, fileName);
    res.json({ file: fileName, extracted_text: extractedText });
  } catch (err) {
    res.status(500).json({
      file: fileName,
      error: `Error processing file: ${err.message}`,
    });
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

async function handleRawFile(req, res) {
  const fileName = req.query.filename;
  if (!fileName) {
    return res.status(400).json({ error: "Missing 'filename' query parameter" });
  }
  const fileBuffer = req.body;
  if (!fileBuffer || fileBuffer.length === 0) {
    return res.status(400).json({ error: "No binary data in request body" });
  }
  try {
    const extractedText = await extractTextFromBuffer(fileBuffer, fileName);
    res.json({ file: fileName, extracted_text: extractedText });
  } catch (err) {
    res.status(500).json({
      file: fileName,
      error: `Error processing file: ${err.message}`,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// XLSX helpers — three fixes (1) range, (2) formulas, (3) symbols/dates
// ──────────────────────────────────────────────────────────────────────────

/**
 * FIX #1 — Recompute !ref:
 *
 * Many XLSX exporters (royalty/finance systems like the one that produced
 * RJR0003639) write a stale "!ref" dimension record that does NOT cover
 * every cell actually present in the sheet. XLSX.utils.sheet_to_csv trusts
 * the declared range and SILENTLY DROPS data rows that fall outside it —
 * this is why numeric totals, per-source breakdowns, and LIYANA rows were
 * missing. We rebuild !ref from the live cells before serializing.
 *
 * Safe on well-formed files: if !ref already covers the data, the
 * recomputed range is identical and nothing changes.
 */
function recomputeSheetRange(ws) {
  const cellKeys = Object.keys(ws).filter((k) => !k.startsWith("!"));
  if (cellKeys.length === 0) return;

  let maxR = -1;
  let maxC = -1;
  for (const k of cellKeys) {
    const addr = XLSX.utils.decode_cell(k);
    if (Number.isNaN(addr.r) || Number.isNaN(addr.c)) continue;
    if (addr.r > maxR) maxR = addr.r;
    if (addr.c > maxC) maxC = addr.c;
  }
  if (maxR < 0) return;

  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: maxR, c: maxC },
  });
}

/**
 * FIX #2 — Strip formulas, keep cached values:
 *
 * Each cell may carry both a cached value (.v) and the formula that produced
 * it (.f, e.g. "SUM(C2:C3)"). We want the NUMBERS as they appear in the
 * sheet, never the formula text. Removing .f forces sheet_to_csv to emit
 * the cached numeric value.
 *
 * Edge case: if a cell has a formula but no cached value (some exporters do
 * not evaluate before saving), we blank the cell rather than let the
 * formula string leak into output.
 */
function stripFormulas(ws) {
  for (const k of Object.keys(ws)) {
    if (k.startsWith("!")) continue;
    const cell = ws[k];
    if (!cell || typeof cell !== "object") continue;
    if (cell.f !== undefined) {
      delete cell.f;   // formula string
      delete cell.F;   // array-formula range
      delete cell.D;   // dynamic-array flag
      if (cell.v === undefined) {
        cell.t = "z";  // blank
        cell.w = "";
      }
    }
  }
}

/**
 * FIX #3 — Preserve currency symbols, percentages, and ISO dates:
 *
 * Excel stores numbers and currency separately. A cell displayed as
 * "$1,103.00" is internally `{ v: 1103, z: '"$"#,##0.00' }`. By default
 * sheet_to_csv would emit only "1103" — losing the "$" entirely. The same
 * applies to €, £, ¥, kr, %, etc.
 *
 * For each cell:
 *   • If it's a date (typed "d" or has a date format), convert to ISO
 *     "YYYY-MM-DD" so downstream parsers don't trip over "11/26/18".
 *   • If it's a number with a format containing a currency or percentage
 *     marker, render it through XLSX.SSF.format and turn the cell into a
 *     string so the symbol survives CSV serialization.
 *   • Otherwise, leave the raw number alone.
 */
const CURRENCY_PERCENT_RX =
  /[$€£¥₹₽¢₩₪₺₫฿]|\[\$[^\]]+\]|\bkr\b|\bSEK\b|\bUSD\b|\bEUR\b|\bGBP\b|\bJPY\b|\bCHF\b|\bNOK\b|\bDKK\b|\bAUD\b|\bCAD\b|%/i;

function isDateFormat(fmt) {
  if (!fmt) return false;
  // Strip quoted literals so '"$"#,##0' (with a literal "s") is not falsely
  // detected as a date format.
  const stripped = fmt.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toIsoDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  // Use UTC components to avoid timezone drift
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function normalizeCells(ws) {
  for (const k of Object.keys(ws)) {
    if (k.startsWith("!")) continue;
    const cell = ws[k];
    if (!cell || typeof cell !== "object") continue;
    if (cell.v === undefined) continue;

    const fmt = cell.z ? String(cell.z) : "";

    // (a) Dates — normalize to ISO
    if (cell.t === "d" || cell.v instanceof Date || (cell.t === "n" && isDateFormat(fmt))) {
      let d = cell.v instanceof Date ? cell.v : null;
      if (!d && typeof cell.v === "number") {
        const parsed = XLSX.SSF.parse_date_code(cell.v);
        if (parsed) {
          d = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, parsed.S));
        }
      }
      const iso = toIsoDate(d);
      if (iso) {
        cell.t = "s";
        cell.v = iso;
        cell.w = iso;
        delete cell.z;
      }
      continue;
    }

    // (b) Currency / percentage — preserve the symbol
    if (cell.t === "n" && fmt && CURRENCY_PERCENT_RX.test(fmt)) {
      try {
        const formatted = XLSX.SSF.format(fmt, cell.v);
        if (formatted && formatted.trim() !== "") {
          cell.t = "s";
          cell.v = formatted;
          cell.w = formatted;
        }
      } catch (_) {
        // Formatting failed — keep raw numeric value rather than crash.
      }
    }
    // (c) Plain numbers / strings: leave untouched.
  }
}

function extractXlsx(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, {
    type: "buffer",
    cellDates: true,    // Excel serial dates → JS Date objects
    cellNF: true,       // keep number-format codes (.z) so we can detect $/€/£/%
    cellText: false,    // raw values, not formatted text
    cellFormula: true,  // parse formulas so we can strip them cleanly
    dense: false,
  });

  let out = "";
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;

    recomputeSheetRange(ws);  // FIX #1
    stripFormulas(ws);        // FIX #2
    normalizeCells(ws);       // FIX #3 (symbols + dates)

    const csv = XLSX.utils.sheet_to_csv(ws, {
      blankrows: true,    // keep row alignment
      skipHidden: false,  // include hidden rows/columns
      strip: false,
      rawNumbers: true,   // emit 1103 not "1,103" for plain numbers
    });

    out += `\n--- SHEET: ${sheetName} ---\n${csv}`;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Text file helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Decode a text file honouring BOMs for UTF-8 and UTF-16 LE/BE so currency
 * symbols and other non-ASCII characters in CSV/TXT files are not corrupted.
 */
function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8");
}

// ──────────────────────────────────────────────────────────────────────────
// Central extraction dispatcher
// ──────────────────────────────────────────────────────────────────────────

async function extractTextFromBuffer(fileBuffer, fileName) {
  const fileExt = path.extname(fileName).toLowerCase().replace(".", "");
  let extractedText = "";

  switch (fileExt) {
    case "pdf": {
      const pdfData = await pdf(fileBuffer);
      extractedText = pdfData.text;
      break;
    }

    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
      extractedText = value;
      break;
    }

    case "xlsx":
    case "xlsm":
    case "xlsb":
    case "xls":
    case "ods": {
      extractedText = extractXlsx(fileBuffer);
      break;
    }

    case "csv":
    case "tsv":
    case "txt":
    case "log":
    case "md":
    case "xml":
    case "html":
    case "htm":
    case "json": {
      extractedText = decodeTextBuffer(fileBuffer);
      break;
    }

    default: {
      // Fallback to textract for legacy formats (.doc, .rtf, .odt, .pptx…)
      extractedText = await new Promise((resolve, reject) => {
        textract.fromBufferWithName(fileName, fileBuffer, (err, text) => {
          if (err) reject(err);
          else resolve(text);
        });
      });
    }
  }

  return (extractedText || "").trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────────

app.post("/extract", upload.single("file"), handleMultipartFile);
app.post("/extract-raw", rawBodyParser, handleRawFile);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(
    `✅ File Extractor running on port ${PORT}. Ready for multipart and raw uploads.`
  )
);
