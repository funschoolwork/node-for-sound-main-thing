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

// ─── Locate yt-dlp ────────────────────────────────────────
const YT_DLP = (() => {
  const candidates = ["/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", "yt-dlp"];
  for (const bin of candidates) {
    try {
      require("child_process").execSync(`${bin} --version`, { stdio: "ignore" });
      return bin;
    } catch {}
  }
  return "yt-dlp"; // assume in PATH
})();

console.log(`[yt-dlp] using: ${YT_DLP}`);
console.log(`[ffmpeg] using: ${ffmpegPath}`);

// ─── Cookie handling ──────────────────────────────────────
const COOKIE_FILE = path.join(__dirname, "cookies.txt");

if (process.env.YT_COOKIE) {
  fs.writeFileSync(COOKIE_FILE, process.env.YT_COOKIE.trim(), "utf-8");
  console.log("✅ YT_COOKIE written to cookies.txt");
} else if (fs.existsSync(COOKIE_FILE) && fs.statSync(COOKIE_FILE).size > 100) {
  console.log("✅ Using existing cookies.txt");
} else {
  console.log("⚠️ No valid cookies → age-restricted / music videos may fail");
}

const cookieArg = fs.existsSync(COOKIE_FILE) && fs.statSync(COOKIE_FILE).size > 100
  ? `--cookies "${COOKIE_FILE}"`
  : "";

// 2026-safe clients (android_sdkless frequently broken → removed)
const CLIENTS = ["android", "ios", "tv_embedded", "mweb", "web"];

// ─── Health ───────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<h1>🎵 YT Downloader</h1><p>Running on port ${PORT}</p>`);
});

// ─── Build args ───────────────────────────────────────────
function buildYtArgs(client = null, extra = "") {
  let args = `${YT_DLP} --no-warnings --ffmpeg-location "${ffmpegPath}"`;

  if (client) {
    args += ` --extractor-args "youtube:player_client=${client}"`;
  }

  args += ` --no-check-certificate ${cookieArg} ${extra}`;
  return args;
}

// ─── /info ────────────────────────────────────────────────
app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  for (const client of CLIENTS) {
    try {
      const cmd = buildYtArgs(client, `--skip-download --print-json "${url}"`);
      const { stdout } = await execAsync(cmd, { timeout: 45000 });
      const jsonLine = stdout.trim().split("\n").find(l => l.startsWith("{")) || stdout.trim();
      const info = JSON.parse(jsonLine);

      console.log(`[info] OK client=${client} — ${info.title || "?"}`);
      return res.json({
        title: info.title || "Unknown",
        duration: info.duration || 0,
        uploader: info.uploader || "Unknown",
        thumbnail: info.thumbnail || null,
      });
    } catch (err) {
      console.log(`[info] ${client} fail: ${err.message.split("\n")[0] || err}`);
    }
  }

  // Fallback: no forced client
  try {
    const cmd = buildYtArgs(null, `--skip-download --print-json "${url}"`);
    const { stdout } = await execAsync(cmd, { timeout: 45000 });
    const jsonLine = stdout.trim().split("\n").find(l => l.startsWith("{")) || stdout.trim();
    const info = JSON.parse(jsonLine);

    return res.json({
      title: info.title || "Unknown",
      duration: info.duration || 0,
      uploader: info.uploader || "Unknown",
    });
  } catch {}

  res.status(500).json({ error: "Failed all clients. Possibly age-restricted, private, or region issue." });
});

// ─── /mp3 ─────────────────────────────────────────────────
app.get("/mp3", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  const ts = Date.now();
  const tmpBase = path.join(DOWNLOADS_DIR, `audio_${ts}`);
  const outPattern = `${tmpBase}.%(ext)s`;
  let finalFile = null;

  // Try clients
  for (const client of CLIENTS) {
    try {
      const cmd = buildYtArgs(
        client,
        `-f bestaudio/best -x --audio-format mp3 --audio-quality 192K -o "${outPattern}" "${url}"`
      );

      console.log(`[mp3] Trying ${client}...`);
      await execAsync(cmd, { timeout: 240000 }); // 4 min for longer tracks

      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(`audio_${ts}`) && f.endsWith(".mp3"));

      if (files.length > 0) {
        finalFile = path.join(DOWNLOADS_DIR, files[0]);
        console.log(`[mp3] Success ${client} → ${finalFile}`);
        break;
      }
    } catch (err) {
      console.log(`[mp3] ${client} fail: ${err.message.split("\n")[0] || err}`);
      // cleanup partials
      fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(`audio_${ts}`))
        .forEach(f => {
          try { fs.unlinkSync(path.join(DOWNLOADS_DIR, f)); } catch {}
        });
    }
  }

  // Final fallback (no client forced)
  if (!finalFile) {
    try {
      const cmd = buildYtArgs(
        null,
        `-f bestaudio/best -x --audio-format mp3 --audio-quality 192K -o "${outPattern}" "${url}"`
      );

      await execAsync(cmd, { timeout: 240000 });
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(`audio_${ts}`) && f.endsWith(".mp3"));

      if (files.length > 0) finalFile = path.join(DOWNLOADS_DIR, files[0]);
    } catch (err) {
      console.log(`[mp3] default fail: ${err.message.split("\n")[0] || err}`);
    }
  }

  if (!finalFile || !fs.existsSync(finalFile)) {
    return res.status(500).json({ error: "All download attempts failed. Try cookies for restricted content." });
  }

  // Stream it
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
  console.log(`🎵 YT MP3 service up on port ${PORT}`);
});
