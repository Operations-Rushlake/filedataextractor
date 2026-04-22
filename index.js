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
// XLSX helpers — two critical fixes
// ──────────────────────────────────────────────────────────────────────────

/**
 * FIX #1 — Recompute !ref:
 *
 * Many XLSX exporters (especially royalty/finance systems like the one that
 * produced RJR0003639) write an out-of-date "!ref" dimension record that
 * does NOT cover every cell actually present in the sheet. When this
 * happens, XLSX.utils.sheet_to_csv trusts the declared range and SILENTLY
 * DROPS data rows that fall outside it — which is why the numeric totals,
 * per-source breakdowns, and LIYANA rows were missing from the extracted
 * text. We recompute the real range from the live cells before serializing.
 *
 * Safe on well-formed files: if !ref already covers the data, the recomputed
 * range is identical and nothing changes.
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
 * FIX #2 — Strip formulas, keep values:
 *
 * Every cell may carry both a cached calculated value (.v) and the formula
 * that produced it (.f, e.g. "SUM(C2:C3)"). We want the NUMBERS as they
 * appear in the sheet, never the formula text. We remove the formula
 * properties so only the cached value remains.
 *
 * Edge case: if a cell has a formula but no cached value (some exporters do
 * not evaluate formulas before saving), we blank the cell rather than let
 * formula text leak into the output.
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

function extractXlsx(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, {
    type: "buffer",
    cellDates: true,    // Excel serial dates → JS Date objects
    cellNF: false,      // do not retain number-format codes
    cellText: false,    // raw values, not formatted text
    cellFormula: true,  // parse formulas so we can strip them cleanly
    dense: false,
  });

  let out = "";
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;

    recomputeSheetRange(ws);  // FIX #1: don't drop data rows
    stripFormulas(ws);        // FIX #2: keep numbers, drop formula text

    const csv = XLSX.utils.sheet_to_csv(ws, {
      blankrows: true,       // keep row alignment
      skipHidden: false,     // include hidden rows/columns
      dateNF: "yyyy-mm-dd",  // ISO dates
      strip: false,
      rawNumbers: true,      // emit 1103 not "1,103"
    });

    out += `\n--- SHEET: ${sheetName} ---\n${csv}`;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Text file helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Decode a text file honouring BOMs for UTF-8, UTF-16 LE/BE so we do not
 * corrupt files exported from Windows/Excel as UTF-16.
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
