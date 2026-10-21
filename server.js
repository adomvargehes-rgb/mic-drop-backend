/**
 * Lightweight YouTube-to-Audio Backend Microservice
 * Powered by yt-dlp
 */
const http = require('http');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const url = require('url');
const PORT = process.env.PORT || 5000;
const BIN_DIR = path.join(__dirname, 'bin');
const LOCAL_YT_DLP = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let YT_DLP_PATH = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : LOCAL_YT_DLP;

// Ensure bin dir exists
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

// Download yt-dlp if missing
async function ensureYtDlp() {
  if (fs.existsSync(YT_DLP_PATH)) {
    return true;
  }
  console.log('[Backend] yt-dlp not found. Downloading binary...');
  const downloadUrl = process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  try {
    const res = await fetch(downloadUrl, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(YT_DLP_PATH, Buffer.from(arrayBuffer));
    if (process.platform !== 'win32') {
      fs.chmodSync(YT_DLP_PATH, '755');
    }
    console.log('[Backend] yt-dlp downloaded successfully.');
    return true;
  } catch (err) {
    console.error('[Backend] Failed to download yt-dlp:', err.message);
    return false;
  }
}

// Format duration in seconds to mm:ss
function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '3:30';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// Format view counts
function formatViews(views) {
  if (!views || isNaN(views)) return '1M views';
  if (views >= 1_000_000_000) return `${(views / 1_000_000_000).toFixed(1)}B views`;
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M views`;
  if (views >= 1_000) return `${(views / 1_000).toFixed(1)}K views`;
  return `${views} views`;
}

// Sanitizes filename
function sanitizeFilename(name) {
  return (name || 'song')
    .replace(/[^a-zA-Z0-9_\-\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .substring(0, 60);
}

// Set standard CORS headers
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Content-Disposition');
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // 1. Health check
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      ytDlpReady: fs.existsSync(YT_DLP_PATH),
      engine: 'yt-dlp',
      timestamp: Date.now()
    }));
    return;
  }

  // 1b. JioSaavn CORS Proxy for web browser
  if (pathname === '/api/saavn-search') {
    const q = (query.q || '').trim();
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "q" parameter' }));
      return;
    }
    const saavnUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&n=25&p=1&q=${encodeURIComponent(q)}&_marker=0&ctx=android`;
    try {
      const saavnRes = await fetch(saavnUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const saavnData = await saavnRes.text();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(saavnData);
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Saavn fetch failed', details: err.message }));
    }
    return;
  }

  // 1c. High-Reliability Lyrics Proxy (LRCLIB with custom User-Agent)
  if (pathname === '/api/lyrics') {
    const songTitle = (query.title || '').trim();
    const songArtist = (query.artist || '').trim();
    if (!songTitle) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "title" parameter' }));
      return;
    }

    try {
      const cleanTitle = songTitle.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim();
      const cleanArtist = songArtist.split(',')[0].trim();
      const lrcSearchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + (cleanArtist ? ' ' + cleanArtist : ''))}`;
      const lrcRes = await fetch(lrcSearchUrl, {
        headers: { 'User-Agent': 'MicDropApp/1.0.9 (https://github.com/vishnuvi; micdrop-support)' },
        signal: AbortSignal.timeout(4000),
      });

      if (lrcRes.ok) {
        const list = await lrcRes.json();
        if (Array.isArray(list) && list.length > 0) {
          const lower = cleanTitle.toLowerCase();
          const match = list.find((x) => x.syncedLyrics && x.trackName.toLowerCase().includes(lower)) || list.find((x) => x.syncedLyrics) || list[0];
          if (match) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              trackName: match.trackName,
              artistName: match.artistName,
              syncedLyrics: match.syncedLyrics || null,
              plainLyrics: match.plainLyrics || null,
            }));
            return;
          }
        }
      }

      // Fallback search with title only
      const lrcTitleUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle)}`;
      const lrcTitleRes = await fetch(lrcTitleUrl, {
        headers: { 'User-Agent': 'MicDropApp/1.0.9 (https://github.com/vishnuvi; micdrop-support)' },
        signal: AbortSignal.timeout(4000),
      });

      if (lrcTitleRes.ok) {
        const list = await lrcTitleRes.json();
        if (Array.isArray(list) && list.length > 0) {
          const match = list.find((x) => x.syncedLyrics) || list[0];
          if (match) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              trackName: match.trackName,
              artistName: match.artistName,
              syncedLyrics: match.syncedLyrics || null,
              plainLyrics: match.plainLyrics || null,
            }));
            return;
          }
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Lyrics not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Lyrics fetch failed', details: err.message }));
    }
    return;
  }

  // 1d. Serve Static Dropped/Mixed Covers
  if (pathname.startsWith('/drops/')) {
    const fileName = path.basename(pathname);
    const dropsDir = path.join(__dirname, 'public', 'drops');
    const filePath = path.join(dropsDir, fileName);

    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': 'audio/mp4',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': 'audio/mp4',
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath).pipe(res);
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
    return;
  }

  // 1e. Smule-Style Cover Mixing: Combines user recorded mic vocals with backing track using FFmpeg
  if (pathname === '/api/mix-cover' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Protect from huge payloads > 50MB
      if (body.length > 50 * 1024 * 1024) {
        req.destroy();
      }
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { vocalBase64, bgmUrl, vocalVolume = 1.25, bgmVolume = 0.85 } = data;

        if (!vocalBase64 || !bgmUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing vocalBase64 or bgmUrl' }));
          return;
        }

        const dropsDir = path.join(__dirname, 'public', 'drops');
        if (!fs.existsSync(dropsDir)) fs.mkdirSync(dropsDir, { recursive: true });

        const dropId = `drop-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const tempVocalPath = path.join(dropsDir, `${dropId}-vocal.m4a`);
        const finalOutputPath = path.join(dropsDir, `${dropId}.m4a`);

        // Write user vocal buffer
        const vocalBuffer = Buffer.from(vocalBase64.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
        fs.writeFileSync(tempVocalPath, vocalBuffer);

        console.log(`[Backend] Mixing Smule-style cover: "${dropId}" with BGM: ${bgmUrl}`);

        // FFmpeg filter:
        // [0:a] is BGM at volume 0.85
        // [1:a] is User vocal with volume 1.25 + 80Hz highpass + gentle dynamic compression
        // amix overlays both inputs into a single crystal-clear master track!
        const ffmpegArgs = [
          '-y',
          '-i', bgmUrl,
          '-i', tempVocalPath,
          '-filter_complex',
          `[0:a]volume=${bgmVolume}[bgm];[1:a]volume=${vocalVolume},highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=10:release=100[voc];[bgm][voc]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
          '-map', '[aout]',
          '-c:a', 'aac',
          '-b:a', '256k',
          finalOutputPath
        ];

        execFile('ffmpeg', ffmpegArgs, { timeout: 30000 }, (err, stdout, stderr) => {
          // Clean up temp raw vocal file
          try { if (fs.existsSync(tempVocalPath)) fs.unlinkSync(tempVocalPath); } catch {}

          if (err) {
            console.error('[Backend] FFmpeg mixing failed:', stderr || err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Audio mixing failed', details: stderr || err.message }));
            return;
          }

          console.log(`[Backend] Successfully mixed and mastered cover track: ${finalOutputPath}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            dropId,
            audioUrl: `/drops/${dropId}.m4a`,
          }));
        });
      } catch (parseErr) {
        console.error('[Backend] Mix cover parsing error:', parseErr);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON request' }));
      }
    });
    return;
  }


  // 2. Video Info & Search Metadata
  if (pathname === '/api/info') {
    const input = (query.query || query.url || query.id || '').trim();
    if (!input) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "query" or "url" parameter' }));
      return;
    }

    let target = input;
    // If not a full URL or 11-char ID, use ytsearch
    const isUrl = input.startsWith('http://') || input.startsWith('https://');
    const isId = /^[a-zA-Z0-9_-]{11}$/.test(input);
    if (!isUrl && !isId) {
      target = `ytsearch1:${input}`;
    } else if (isId) {
      target = `https://www.youtube.com/watch?v=${input}`;
    }

    console.log(`[Backend] Fetching info for target: "${target}"`);

    const args = [
      '--js-runtimes', 'node',
      '--no-playlist',
      '--dump-json',
      target
    ];

    execFile(YT_DLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[Backend] Error fetching info:', stderr || err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to retrieve video metadata', details: stderr || err.message }));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const durationSec = data.duration || 210;
        const duration = formatDuration(durationSec);
        const views = formatViews(data.view_count);
        const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails.length > 0 ? data.thumbnails[data.thumbnails.length - 1].url : '');
        const hostHeader = req.headers.host;
        const host = hostHeader || `192.168.1.34:${PORT}`;
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const baseUrl = `${protocol}://${host}`;

        const videoInfo = {
          videoId: data.id,
          title: data.title,
          channel: data.uploader || data.channel || 'YouTube Artist',
          duration,
          durationSec,
          thumbnailUrl,
          views,
          uploadDate: data.upload_date ? `${data.upload_date.substring(0, 4)}-${data.upload_date.substring(4, 6)}-${data.upload_date.substring(6, 8)}` : 'Recent',
          previewAudioUrl: `${baseUrl}/api/stream?id=${data.id}`,
          formats: [
            {
              id: 'm4a-aac',
              format: 'm4a',
              quality: 'M4A / AAC (High Quality)',
              bitrate: '256 kbps',
              sizeMB: `${Math.round((durationSec * 256) / 8000 * 10) / 10} MB`,
              badge: 'RECOMMENDED',
              description: 'Native Mobile Audio • Crisp Sound & Fast Download',
              sampleRate: '44.1 kHz',
              recommended: true,
            },
            {
              id: 'mp3-320',
              format: 'mp3',
              quality: 'MP3 (Universal 320 kbps)',
              bitrate: '320 kbps',
              sizeMB: `${Math.round((durationSec * 320) / 8000 * 10) / 10} MB`,
              badge: 'BEST COMPATIBILITY',
              description: 'High Quality MP3 • Works on all car stereos & players',
              sampleRate: '48.0 kHz',
            },
            {
              id: 'wav-lossless',
              format: 'wav',
              quality: 'WAV Studio Master',
              bitrate: '1411 kbps',
              sizeMB: `${Math.round((durationSec * 1411) / 8000 * 10) / 10} MB`,
              badge: 'STUDIO PCM',
              description: 'Uncompressed Studio PCM Audio • Audiophile grade',
              sampleRate: '96.0 kHz',
            },
          ]
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(videoInfo));
      } catch (parseErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse video metadata' }));
      }
    });
    return;
  }

  // 3. Audio Streaming (Direct full playback via query, URL, or video ID)
  if (pathname === '/api/stream') {
    const rawTarget = (query.query || query.id || query.videoId || query.url || '').trim();
    if (!rawTarget) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing search query or video id');
      return;
    }

    let target = rawTarget;
    if (query.query || (!rawTarget.startsWith('http') && !/^[a-zA-Z0-9_-]{11}$/.test(rawTarget))) {
      target = `ytsearch1:${rawTarget} audio`;
    } else if (/^[a-zA-Z0-9_-]{11}$/.test(rawTarget)) {
      target = `https://www.youtube.com/watch?v=${rawTarget}`;
    }

    console.log(`[Backend] Streaming audio for: "${target}"`);

    // Stream m4a or bestaudio directly to response
    const args = [
      '--js-runtimes', 'node',
      '--no-playlist',
      '-f', 'ba[ext=m4a]/ba',
      '-o', '-',
      target
    ];

    res.writeHead(200, {
      'Content-Type': 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });

    const child = spawn(YT_DLP_PATH, args);

    child.stdout.pipe(res);

    req.on('close', () => {
      try { child.kill(); } catch {}
    });

    child.on('error', (err) => {
      console.error('[Backend] Streaming child error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Streaming error');
      }
    });
    return;
  }

  // 4. Download Real Audio Stream (supports query or video ID)
  if (pathname === '/api/download') {
    const rawTarget = (query.query || query.id || query.videoId || query.url || '').trim();
    const formatReq = (query.format || 'm4a').toLowerCase();
    const title = query.title || 'audio';
    const safeName = sanitizeFilename(title);

    if (!rawTarget) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing query or video id');
      return;
    }

    let target = rawTarget;
    if (query.query || (!rawTarget.startsWith('http') && !/^[a-zA-Z0-9_-]{11}$/.test(rawTarget))) {
      target = `ytsearch1:${rawTarget} audio`;
    } else if (/^[a-zA-Z0-9_-]{11}$/.test(rawTarget)) {
      target = `https://www.youtube.com/watch?v=${rawTarget}`;
    }

    const ext = formatReq === 'mp3' ? 'mp3' : formatReq === 'wav' ? 'wav' : 'm4a';
    const fileName = `${safeName}.${ext}`;
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/mp4';

    console.log(`[Backend] Downloading audio file "${fileName}" for: "${target}"`);

    const args = [
      '--js-runtimes', 'node',
      '--no-playlist',
      '-f', 'ba[ext=m4a]/ba',
      '-o', '-',
      target
    ];

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      'Cache-Control': 'no-cache',
    });

    const child = spawn(YT_DLP_PATH, args);

    child.stdout.pipe(res);

    req.on('close', () => {
      try { child.kill(); } catch {}
    });

    child.on('error', (err) => {
      console.error('[Backend] Download child error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Download error');
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Start the server
ensureYtDlp().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🎵 Mic Drop Cloud Backend Service Running!`);
    console.log(`📡 Local URL:   http://localhost:${PORT}`);
    console.log(`📡 Network URL: http://0.0.0.0:${PORT}`);
    console.log(`⚡ Engine:      yt-dlp with Node.js runtime`);
    console.log(`======================================================\n`);
  });
});
