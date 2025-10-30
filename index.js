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

// --- NEW MIDDLEWARE ---
// This middleware will parse raw binary bodies
// We set a high limit to accept large files.
const rawBodyParser = express.raw({
  type: "*/*", // Accept all content types
  limit: "1tb",
});

// Simple health check endpoint
app.get("/", (req, res) => {
  res.json({ message: "📄 File Data Extractor microservice is running" });
});

// --- ORIGINAL HANDLER (FOR MULTIPART/FORM-DATA) ---
// This function now only handles req.file (from multer)
async function handleMultipartFile(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const fileBuffer = fs.readFileSync(filePath);

  try {
    const extractedText = await extractTextFromBuffer(fileBuffer, fileName);
    res.json({
      file: fileName,
      extracted_text: extractedText,
    });
  } catch (err) {
    res.status(500).json({
      file: fileName,
      error: `Error processing file: ${err.message}`,
    });
  } finally {
    // Always remove uploaded temp file
    fs.unlinkSync(filePath);
  }
}

// --- NEW HANDLER (FOR RAW BINARY) ---
// This function handles req.body (from express.raw)
async function handleRawFile(req, res) {
  // We get the filename from the query parameter
  const fileName = req.query.filename;

  if (!fileName) {
    return res
      .status(400)
      .json({ error: "Missing 'filename' query parameter" });
  }

  // The raw binary data is in req.body
  const fileBuffer = req.body;

  if (!fileBuffer || fileBuffer.length === 0) {
    return res.status(400).json({ error: "No binary data in request body" });
  }

  try {
    const extractedText = await extractTextFromBuffer(fileBuffer, fileName);
    res.json({
      file: fileName,
      extracted_text: extractedText,
    });
  } catch (err) {
    res.status(500).json({
      file: fileName,
      error: `Error processing file: ${err.message}`,
    });
  }
}

// --- SHARED EXTRACTION LOGIC ---
// Both handlers now use this central function
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
    case "xls": {
      const workbook = XLSX.read(fileBuffer, { type: "buffer" });
      workbook.SheetNames.forEach((sheetName) => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
        extractedText += `\n--- SHEET: ${sheetName} ---\n${csv}`;
      });
      break;
    }
    case "csv":
    case "txt":
    case "json": {
      extractedText = fileBuffer.toString("utf8");
      break;
    }
    default: {
      // Try with textract (supports many formats)
      extractedText = await new Promise((resolve, reject) => {
        textract.fromBufferWithName(fileName, fileBuffer, (err, text) => {
          if (err) reject(err);
          else resolve(text);
        });
      });
    }
  }
  return extractedText.trim();
}

// --- ENDPOINTS ---


// OPTION 2 ENDPOINT: Accepts raw binary data
// Use this with n8n "n8n Binary File" AND add ?filename=... to the URL
app.post("/extract-raw", rawBodyParser, handleRawFile);


const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(
    `✅ File Extractor running on port ${PORT}. Ready for multipart and raw uploads.`
  )
);
