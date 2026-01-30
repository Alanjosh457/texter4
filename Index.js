import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import cron from "node-cron";

const app = express();

/* =====================
   CONFIG
===================== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const API_KEY = process.env.API_KEY;

// Chunking controls
const CHUNK_SIZE = 3000;       // chars per chunk (safe for most LLMs)
const CHUNK_OVERLAP = 300;     // overlap for context continuity

/* =====================
   AUTH
===================== */
function authenticate(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!API_KEY || apiKey !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* =====================
   HEALTH CHECK
===================== */
app.get("/", (req, res) => {
  res.send("Text extractor running");
});

/* =====================
   PDF EXTRACTOR
===================== */
async function extractPDFText(buffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
  });

  const pdf = await loadingTask.promise;
  let fullText = "";

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const texts = content.items.map(item => item.str);
    fullText += texts.join(" ") + "\n";
  }

  return fullText;
}

/* =====================
   CHUNKING
===================== */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = start + size;
    chunks.push(text.slice(start, end));
    start += size - overlap;
  }

  return chunks;
}

/* =====================
   MAIN ENDPOINT
===================== */
app.post(
  "/extract",
  authenticate,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { buffer, mimetype, originalname } = req.file;
      let text = "";

      // DOCX
      if (
        mimetype ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        originalname.toLowerCase().endsWith(".docx")
      ) {
        const result = await mammoth.extractRawText({
          buffer,
          ignoreEmptyParagraphs: true
        });
        text = result.value;
      }

      // PDF
      else if (
        mimetype === "application/pdf" ||
        originalname.toLowerCase().endsWith(".pdf")
      ) {
        text = await extractPDFText(buffer);
      }

      else {
        return res.status(400).json({ error: "Unsupported file type" });
      }

      // Cleanup for AI
      text = text
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+/g, " ")
        .trim();

      const chunks = chunkText(text);

      res.json({
        success: true,
        filename: originalname,
        characters: text.length,
        chunk_count: chunks.length,
        chunks
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Extraction failed" });
    }
  }
);

/* =====================
   SAFE CRON JOB (Render-friendly)
===================== */
cron.schedule("*/10 * * * *", () => {
  // Light, safe task
  console.log(`[CRON] heartbeat @ ${new Date().toISOString()}`);

  // Optional: hint GC (only if enabled)
  if (global.gc) {
    global.gc();
  }
});

/* =====================
   SERVER
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


