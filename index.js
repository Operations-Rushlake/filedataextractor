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

app.get("/", (req, res) => {
  res.json({ message: "📄 File Data Extractor microservice is running" });
});

app.post("/extract", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const fileExt = path.extname(fileName).toLowerCase().replace(".", "");
  const fileBuffer = fs.readFileSync(filePath);

  let extractedText = "";

  try {
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
        extractedText = await new Promise((resolve, reject) => {
          textract.fromBufferWithName(fileName, fileBuffer, (err, text) => {
            if (err) reject(err);
            else resolve(text);
          });
        });
      }
    }

    res.json({
      file: fileName,
      extracted_text: extractedText.trim(),
    });
  } catch (err) {
    res.status(500).json({
      file: fileName,
      error: err.message,
    });
  } finally {
    fs.unlinkSync(filePath); // cleanup temp file
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ File Extractor running on port ${PORT}`));
