import express from "express";
import bodyParser from "body-parser";
import multer from "multer";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import xlsx from "xlsx";
import mammoth from "mammoth";
import { parse as csvParse } from "csv-parse/sync";
import textract from "textract";
import { fileTypeFromBuffer } from "file-type";

const app = express();
const upload = multer({ dest: "uploads/" });

// Remove file-size limits
app.use(bodyParser.json({ limit: "10tb" }));
app.use(bodyParser.urlencoded({ limit: "10tb", extended: true }));

async function extractFileContent(filePath, originalName) {
  const buffer = fs.readFileSync(filePath);
  const type = await fileTypeFromBuffer(buffer);
  const ext = (type?.ext || path.extname(originalName).replace(".", "")).toLowerCase();
  const metadata = { fileType: ext, size: fs.statSync(filePath).size, name: originalName };
  let result = { text: "", data: null };

  try {
    if (ext === "pdf") {
      const pdfData = await pdf(buffer);
      result.text = pdfData.text;
    } else if (["xls", "xlsx"].includes(ext)) {
      const workbook = xlsx.read(buffer, { type: "buffer" });
      result.data = workbook.SheetNames.map((name) => ({
        name,
        data: xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1 }),
      }));
      result.text = result.data.map(s => `${s.name}: ${JSON.stringify(s.data)}`).join("\n");
    } else if (["docx"].includes(ext)) {
      const doc = await mammoth.extractRawText({ buffer });
      result.text = doc.value;
    } else if (["csv"].includes(ext)) {
      const csvData = csvParse(buffer.toString(), { skip_empty_lines: true });
      result.data = csvData;
      result.text = csvData.map(r => r.join(" ")).join("\n");
    } else {
      // Fallback to textract for any other file (ppt, txt, odt, rtf, etc.)
      result.text = await new Promise((resolve, reject) => {
        textract.fromBufferWithMime(type?.mime || "text/plain", buffer, (err, text) => {
          if (err) reject(err);
          else resolve(text);
        });
      });
    }
  } catch (err) {
    result.text = `Error extracting content: ${err.message}`;
  }

  return { metadata, ...result };
}

app.post("/extract", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filePath = req.file.path;
  const originalName = req.file.originalname;

  try {
    const output = await extractFileContent(filePath, originalName);
    fs.unlinkSync(filePath); // cleanup
    res.json(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ File Extractor API running on port ${PORT}`));
