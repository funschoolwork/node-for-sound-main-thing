const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// Write cookie file from env if present
const COOKIE_FILE = path.join(__dirname, "cookies.txt");
if (process.env.YT_COOKIE) {
  fs.writeFileSync(COOKIE_FILE, process.env.YT_COOKIE, "utf-8");
  console.log("✅ Cookie file created.");
} else {
  console.log("⚠️  No YT_COOKIE found.");
}

// ─── Health check ────────────────────────────────
app.get("/", (req, res) => {
  res.send("<h1>🎵 YT Service</h1><p>Running.</p>");
});

// ─── /info  — returns title, duration, uploader ──
app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  const cookieArg = fs.existsSync(COOKIE_FILE) && fs.statSync(COOKIE_FILE).size > 0
    ? `--cookies "${COOKIE_FILE}"`
    : "";

  try {
    const { stdout } = await execAsync(
      `yt-dlp --no-warnings --skip-download --print-json \
       --extractor-args "youtube:player_client=android_vr" \
       ${cookieArg} "${url}"`,
      { timeout: 30000 }
    );
    const info = JSON.parse(stdout.trim().split("\n")[0]);
    res.json({
      title:    info.title    || "Unknown",
      duration: info.duration || 0,
      uploader: info.uploader || "Unknown",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /mp3  — downloads and streams MP3 back ──────
app.get("/mp3", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  const cookieArg = fs.existsSync(COOKIE_FILE) && fs.statSync(COOKIE_FILE).size > 0
    ? `--cookies "${COOKIE_FILE}"`
    : "";

  // Temp filename using timestamp to avoid collisions
  const tmpBase = path.join(DOWNLOADS_DIR, `audio_${Date.now()}`);
  const outMp3  = `${tmpBase}.mp3`;

  try {
    await execAsync(
      `yt-dlp --no-warnings -f bestaudio/best \
       --extractor-args "youtube:player_client=android_vr" \
       --no-check-certificate \
       -x --audio-format mp3 --audio-quality 192K \
       ${cookieArg} \
       -o "${tmpBase}.%(ext)s" "${url}"`,
      { timeout: 120000 }
    );

    if (!fs.existsSync(outMp3)) {
      // yt-dlp sometimes names it differently — find it
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(path.basename(tmpBase)) && f.endsWith(".mp3"));
      if (!files.length) return res.status(500).json({ error: "MP3 not found after conversion" });
      const found = path.join(DOWNLOADS_DIR, files[0]);
      return streamAndClean(res, found);
    }

    streamAndClean(res, outMp3);
  } catch (e) {
    // Clean up any partial files
    try {
      fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(path.basename(tmpBase)))
        .forEach(f => fs.unlinkSync(path.join(DOWNLOADS_DIR, f)));
    } catch {}
    res.status(500).json({ error: e.message });
  }
});

function streamAndClean(res, filePath) {
  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("close", () => {
    try { fs.unlinkSync(filePath); } catch {}
  });
}

app.listen(PORT, () => {
  console.log(`🎵 YT Service running on port ${PORT}`);
});
