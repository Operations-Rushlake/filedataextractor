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
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const fileBuffer = fs.readFileSync(filePath);
  try {
    const extractedText = await extractTextFromBuffer(fileBuffer, fileName);
    res.json({ file: fileName, extracted_text: extractedText });
  } catch (err) {
    res.status(500).json({ file: fileName, error: `Error processing file: ${err.message}` });
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

async function handleRawFile(req, res) {
  const fileName = req.query.filename;
  if (!fileName) return res.status(400).json({ error: "Missing 'filename' query parameter" });
  const fileBuffer = req.body;
  if (!fileBuffer || fileBuffer.length === 0) {
    return res.status(400).json({ error: "No binary data in request body" });
  }
  try {
    const extractedText = await extractTextFromBuffer(fileBuffer, fileName);
    res.json({ file: fileName, extracted_text: extractedText });
  } catch (err) {
    res.status(500).json({ file: fileName, error: `Error processing file: ${err.message}` });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// XLSX extraction — RAW DATA, AS DISPLAYED
// ──────────────────────────────────────────────────────────────────────────
//
// Strategy: emit each cell's rendered text (cell.w) — exactly what the
// spreadsheet displays. No date conversion, no currency formatting, no
// number normalization. Whatever you see in Excel / Google Sheets is what
// you get out. This avoids every misclassification trap (currency cells
// becoming dates, locale-tagged formats being misread, etc.).
//
// Two knobs make this work:
//   1. cellNF: true on read — preserves number-format codes so cell.w
//      reflects the user-visible display ($6.13 not 6.13).
//   2. sheet_to_csv default options — uses cell.w when present, falls back
//      to cell.v only if no rendered text exists. Crucially, rawNumbers is
//      NOT set to true: that would force raw numeric values and strip
//      currency symbols.
//
// One safety fix is still required:
//   • recomputeSheetRange — many royalty/finance exporters write a stale
//     "!ref" that doesn't cover all live cells, causing sheet_to_csv to
//     silently drop rows. We rebuild it from the actual cells.
//

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

function extractXlsx(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, {
    type: "buffer",
    cellNF: true,   // Preserve number formats so cell.w reflects them.
  });

  let out = "";
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;

    recomputeSheetRange(ws);  // Don't drop data rows due to stale !ref.

    // sheet_to_csv with default rawNumbers (false) emits cell.w, the
    // rendered display text — exactly what the user sees in the file.
    const csv = XLSX.utils.sheet_to_csv(ws, {
      blankrows: true,
      skipHidden: false,
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
