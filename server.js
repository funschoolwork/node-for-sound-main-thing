const express   = require("express");
const ffmpegPath = require("ffmpeg-static");
const { exec }  = require("child_process");
const fs        = require("fs");
const path      = require("path");
const { promisify } = require("util");

const execAsync = promisify(exec);
const app       = express();
const PORT      = process.env.PORT || 3000;

// ─── Find yt-dlp binary ──────────────────────────
const YT_DLP = (() => {
  for (const p of ["/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", "yt-dlp"]) {
    try { require("child_process").execSync(`${p} --version`, { stdio: "ignore" }); return p; } catch {}
  }
  return "yt-dlp";
})();
console.log(`[yt-dlp] using: ${YT_DLP}`);
console.log(`[ffmpeg] using: ${ffmpegPath}`);

const DOWNLOADS_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

// ─── Clients to try in order (no cookies — avoids forced web client) ─
// We intentionally do NOT pass cookies so yt-dlp doesn't switch to web client
const CLIENTS = ["android_sdkless", "android", "ios", "tv_embedded"];

// ─── Health check ────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<h1>🎵 YT Service</h1><p>Running. yt-dlp: ${YT_DLP}</p>`);
});

// ─── /info ───────────────────────────────────────
app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  for (const client of CLIENTS) {
    try {
      const { stdout } = await execAsync(
        `${YT_DLP} --no-warnings --skip-download --print-json` +
        ` --ffmpeg-location "${ffmpegPath}"` +
        ` --extractor-args "youtube:player_client=${client}"` +
        ` "${url}"`,
        { timeout: 30000 }
      );
      const info = JSON.parse(stdout.trim().split("\n")[0]);
      console.log(`[info] success with client: ${client}`);
      return res.json({
        title:    info.title    || "Unknown",
        duration: info.duration || 0,
        uploader: info.uploader || "Unknown",
      });
    } catch (e) {
      console.log(`[info] client ${client} failed: ${e.message.split("\n")[0]}`);
    }
  }

  res.status(500).json({ error: "All clients failed to fetch video info" });
});

// ─── /mp3 ────────────────────────────────────────
app.get("/mp3", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  const tmpBase = path.join(DOWNLOADS_DIR, `audio_${Date.now()}`);
  const outMp3  = `${tmpBase}.mp3`;

  for (const client of CLIENTS) {
    try {
      await execAsync(
        `${YT_DLP} --no-warnings -f bestaudio/best` +
        ` --ffmpeg-location "${ffmpegPath}"` +
        ` --extractor-args "youtube:player_client=${client}"` +
        ` --no-check-certificate` +
        ` -x --audio-format mp3 --audio-quality 192K` +
        ` -o "${tmpBase}.%(ext)s" "${url}"`,
        { timeout: 120000 }
      );

      // Find the output file
      let finalPath = outMp3;
      if (!fs.existsSync(finalPath)) {
        const files = fs.readdirSync(DOWNLOADS_DIR)
          .filter(f => f.startsWith(path.basename(tmpBase)) && f.endsWith(".mp3"));
        if (!files.length) throw new Error("MP3 not found after conversion");
        finalPath = path.join(DOWNLOADS_DIR, files[0]);
      }

      console.log(`[mp3] success with client: ${client}`);
      return streamAndClean(res, finalPath);

    } catch (e) {
      console.log(`[mp3] client ${client} failed: ${e.message.split("\n")[0]}`);
      // Clean up partial files before trying next client
      try {
        fs.readdirSync(DOWNLOADS_DIR)
          .filter(f => f.startsWith(path.basename(tmpBase)))
          .forEach(f => fs.unlinkSync(path.join(DOWNLOADS_DIR, f)));
      } catch {}
    }
  }

  res.status(500).json({ error: "All clients failed to convert video" });
});

function streamAndClean(res, filePath) {
  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("close", () => { try { fs.unlinkSync(filePath); } catch {} });
}

app.listen(PORT, () => console.log(`🎵 YT Service running on port ${PORT}`));
