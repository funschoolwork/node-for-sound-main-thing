const express = require("express");
const ffmpegPath = require("ffmpeg-static");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

const DOWNLOADS_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ─── yt-dlp binary location ────────────────────────────────────────
const YT_DLP = (() => {
  const candidates = ["/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", "yt-dlp"];
  for (const bin of candidates) {
    try {
      require("child_process").execSync(`${bin} --version`, { stdio: "ignore" });
      return bin;
    } catch {}
  }
  return "yt-dlp";
})();

console.log(`[yt-dlp] using: ${YT_DLP}`);
console.log(`[ffmpeg] using: ${ffmpegPath}`);

// ─── Cookie from env ──────────────────────
const COOKIE_FILE = path.join(__dirname, "cookies.txt");

let cookieArg = "";
if (process.env.YT_COOKIE) {
  fs.writeFileSync(COOKIE_FILE, process.env.YT_COOKIE.trim(), "utf-8");
  console.log("✅ Cookies written from YT_COOKIE env");
  cookieArg = `--cookies "${COOKIE_FILE}"`;
} else if (fs.existsSync(COOKIE_FILE) && fs.statSync(COOKIE_FILE).size > 100) {
  console.log("✅ Using existing cookies.txt");
  cookieArg = `--cookies "${COOKIE_FILE}"`;
} else {
  console.log("⚠️ No cookies provided → restricted videos may fail");
}

// Note: For PO Tokens, install bgutil-ytdlp-pot-provider via pip in Render build:
// pip install -U bgutil-ytdlp-pot-provider
// yt-dlp will auto-use it for web/mweb clients needing tokens.

// ─── Build yt-dlp command base ──────────────────────────────────────
function buildYtArgs(extra = "") {
  let args = `${YT_DLP} --no-warnings --ffmpeg-location "${ffmpegPath}"`;

  // 2026-safe: default + mweb to trigger PO provider if needed
  args += ` --extractor-args "youtube:player_client=default,mweb"`;

  // Optional: Add player_skip if conflicts arise
  // args += `;player_skip=webpage,configs`;

  args += ` --no-check-certificate ${cookieArg} ${extra}`;
  return args;
}

// ─── Health check ───────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<h1>🎵 YT Downloader (with PO Provider support)</h1><p>Running on port ${PORT}</p>`);
});

// ─── /info endpoint ─────────────────────────────────────────────────
app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const cmd = buildYtArgs(`--skip-download --print-json "${url}"`);
    const { stdout } = await execAsync(cmd, { timeout: 60000 });

    const jsonLine = stdout.trim().split("\n").find(l => l.startsWith("{")) || stdout.trim();
    const info = JSON.parse(jsonLine);

    console.log(`[info] Success — ${info.title || "?"}`);

    return res.json({
      title: info.title || "Unknown",
      duration: info.duration || 0,
      uploader: info.uploader || "Unknown",
      thumbnail: info.thumbnail || null,
    });
  } catch (err) {
    console.error(`[info] Failed: ${err.message.split("\n")[0] || err}`);
    res.status(500).json({
      error: "Failed to fetch info. Check logs. Ensure PO provider is installed and cookies are fresh.",
    });
  }
});

// ─── /mp3 endpoint ──────────────────────────────────────────────────
app.get("/mp3", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  const ts = Date.now();
  const tmpBase = path.join(DOWNLOADS_DIR, `audio_${ts}`);
  const outPattern = `${tmpBase}.%(ext)s`;
  let finalFile = null;

  try {
    const cmd = buildYtArgs(
      `-f bestaudio/best -x --audio-format mp3 --audio-quality 192K -o "${outPattern}" "${url}"`
    );

    console.log(`[mp3] Starting download...`);
    await execAsync(cmd, { timeout: 300000 }); // 5 min timeout

    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.startsWith(`audio_${ts}`) && f.endsWith(".mp3"));

    if (files.length > 0) {
      finalFile = path.join(DOWNLOADS_DIR, files[0]);
      console.log(`[mp3] Success → ${finalFile}`);
    }
  } catch (err) {
    console.error(`[mp3] Failed: ${err.message.split("\n")[0] || err}`);
  }

  if (!finalFile || !fs.existsSync(finalFile)) {
    return res.status(500).json({ error: "Download failed. Install PO provider / refresh cookies." });
  }

  // Stream & cleanup
  const stat = fs.statSync(finalFile);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", stat.size);
  const safeName = path.basename(finalFile).replace(/^audio_\d+\./, "audio.");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

  const stream = fs.createReadStream(finalFile);
  stream.pipe(res);

  stream.on("close", () => {
    try { fs.unlinkSync(finalFile); } catch {}
  });
});

app.listen(PORT, () => {
  console.log(`🎵 YT MP3 service running on port ${PORT}`);
});
