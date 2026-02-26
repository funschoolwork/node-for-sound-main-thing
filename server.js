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
if (!fs.existsSync(DOWNS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// ─── Locate yt-dlp ────────────────────────────────────────
const YT_DLP = (() => {
  const candidates = [
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "yt-dlp",
  ];
  for (const bin of candidates) {
    try {
      require("child_process").execSync(`${bin} --version`, { stdio: "ignore" });
      return bin;
    } catch {}
  }
  return "yt-dlp"; // hope it's in PATH
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
  console.log("⚠️  No valid cookies.txt or YT_COOKIE env var → age-restricted content will likely fail");
}

const cookieArg = fs.existsSync(COOKIE_FILE) && fs.statSync(COOKIE_FILE).size > 100
  ? `--cookies "${COOKIE_FILE}"`
  : "";

// Modern safe client order (2026 reality — avoid android_sdkless if possible)
const CLIENTS = [
  "android",          // usually most stable
  "ios",
  "tv_embedded",
  "mweb",
  "web",              // fallback — sometimes needed with cookies
];

// ─── Health check ─────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<h1>🎵 YT Downloader</h1><p>Running on port ${PORT}</p>`);
});

// ─── Build yt-dlp arguments ───────────────────────────────
function buildYtArgs(client = null, extra = "") {
  let args = `${YT_DLP} --no-warnings --ffmpeg-location "${ffmpegPath}"`;

  if (client) {
    // In 2026 avoid player_skip=webpage in many cases — it breaks cookie auth too often
    args += ` --extractor-args "youtube:player_client=${client}"`;
  }

  args += ` --no-check-certificate ${cookieArg} ${extra}`;
  return args;
}

// ─── /info endpoint ───────────────────────────────────────
app.get("/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });

  for (const client of CLIENTS) {
    try {
      const cmd = buildYtArgs(client, `--skip-download --print-json "${url}"`);
      const { stdout } = await execAsync(cmd, { timeout: 40000 });

      // Take first valid JSON line (in case of multiple)
      const jsonLine = stdout.trim().split("\n").find(line => line.trim().startsWith("{")) || stdout.trim();
      const info = JSON.parse(jsonLine);

      console.log(`[info] OK — client=${client} — ${info.title || "???"}`);

      return res.json({
        title: info.title || "Unknown",
        duration: info.duration || 0,
        uploader: info.uploader || "Unknown",
        thumbnail: info.thumbnail || null,
        webpage_url: info.webpage_url || url,
      });
    } catch (err) {
      const msg = err.message || err;
      console.log(`[info] client ${client} failed: ${msg.split("\n")[0]}`);
    }
  }

  // Last attempt — no forced client
  try {
    const cmd = buildYtArgs(null, `--skip-download --print-json "${url}"`);
    const { stdout } = await execAsync(cmd, { timeout: 40000 });
    const info = JSON.parse(stdout.trim().split("\n").find(l => l.startsWith("{")) || stdout.trim());

    return res.json({
      title: info.title || "Unknown",
      duration: info.duration || 0,
      uploader: info.uploader || "Unknown",
    });
  } catch {}

  res.status(500).json({ error: "Could not fetch video info — maybe age-restricted or region-locked?" });
});

// ─── /mp3 endpoint ────────────────────────────────────────
app.get("/mp3", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });

  const timestamp = Date.now();
  const tmpBase = path.join(DOWNLOADS_DIR, `audio_${timestamp}`);
  const outPattern = `${tmpBase}.%(ext)s`;

  let success = false;
  let finalFile = null;

  // Try forced clients first
  for (const client of CLIENTS) {
    try {
      const cmd = buildYtArgs(
        client,
        `-f bestaudio/best -x --audio-format mp3 --audio-quality 192K` +
        ` -o "${outPattern}" "${url}"`
      );

      console.log(`[mp3] Trying client ${client}...`);
      await execAsync(cmd, { timeout: 180000 }); // 3 min — longer videos need this

      // Find the created .mp3
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(`audio_${timestamp}`) && f.endsWith(".mp3"));

      if (files.length > 0) {
        finalFile = path.join(DOWNLOADS_DIR, files[0]);
        console.log(`[mp3] Success with client ${client} → ${finalFile}`);
        success = true;
        break;
      }
    } catch (err) {
      console.log(`[mp3] client ${client} failed: ${err.message.split("\n")[0]}`);
      // Clean partial files
      try {
        fs.readdirSync(DOWNLOADS_DIR)
          .filter(f => f.startsWith(`audio_${timestamp}`))
          .forEach(f => fs.unlinkSync(path.join(DOWNLOADS_DIR, f)));
      } catch {}
    }
  }

  // Final fallback — default client (no forced player_client)
  if (!success) {
    try {
      const cmd = buildYtArgs(
        null,
        `-f bestaudio/best -x --audio-format mp3 --audio-quality 192K` +
        ` -o "${outPattern}" "${url}"`
      );

      await execAsync(cmd, { timeout: 180000 });
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(`audio_${timestamp}`) && f.endsWith(".mp3"));

      if (files.length > 0) {
        finalFile = path.join(DOWNLOADS_DIR, files[0]);
        success = true;
      }
    } catch (err) {
      console.log(`[mp3] default client failed: ${err.message.split("\n")[0]}`);
    }
  }

  if (!success || !finalFile || !fs.existsSync(finalFile)) {
    return res.status(500).json({ error: "All attempts failed. Video may be age-restricted, private, or YouTube changed signature handling." });
  }

  // Stream & clean up
  const stat = fs.statSync(finalFile);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", stat.size);
  // Better filename — try to use title if possible (optional improvement)
  const safeName = path.basename(finalFile).replace(/^audio_\d+\./, "audio.");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

  const stream = fs.createReadStream(finalFile);
  stream.pipe(res);

  stream.on("close", () => {
    try { fs.unlinkSync(finalFile); } catch {}
  });
});

app.listen(PORT, () => {
  console.log(`🎵 YT MP3 service running on http://localhost:${PORT}`);
});
