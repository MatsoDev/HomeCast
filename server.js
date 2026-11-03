'use strict';
require('dotenv').config();
var express = require('express');
var http = require('http');
var WebSocket = require('ws');
var os = require('os');
var dns = require('dns').promises;
var net = require('net');
var https = require('https');
var httpClient = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var spawn = require('child_process').spawn;
var { URL } = require('url');

var PORT = Number(process.env.PORT || 3000);
var TOKEN = process.env.PAIRING_TOKEN || '';
var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ noServer: true });
var clients = new Set();
var lastCast = null;
var lastError = null;
var lastTVState = null;
var rateMap = Object.create(null);
var mirrors = Object.create(null);
var activeMirrorId = null;

function log(level, event, data) { console.log(JSON.stringify({ time: new Date().toISOString(), level: level, event: event, data: data || {} })); }
function auth(req, res, next) {
  if (TOKEN && req.get('x-pairing-token') !== TOKEN) return res.status(401).json({ error: 'Invalid pairing token' });
  next();
}
app.use(function (req, res, next) {
  var origin = req.get('origin') || '';
  if (/^(chrome-extension:\/\/|file:\/\/|http:\/\/|https:\/\/)/.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pairing-Token, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '32kb' }));
function broadcast(obj) {
  var packet = JSON.stringify(obj);
  clients.forEach(function (ws) { if (ws.readyState === WebSocket.OPEN) ws.send(packet); });
}
function validUrl(value) {
  try { var u = new URL(value); return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length < 256; } catch (_) { return false; }
}
function codecWarning(url) {
  return /\.(mkv|webm|avi|flv)(?:$|\?)/i.test(url) || /\.(mpd)(?:$|\?)/i.test(url) ? 'This container/stream may use an unsupported codec; try /transcode for H.264/AAC.' : '';
}
app.post('/cast', auth, function (req, res) {
  var b = req.body || {};
  if (!validUrl(b.url) || typeof b.title !== 'string' || b.title.length > 300 || !isFinite(Number(b.currentTime || 0))) return res.status(400).json({ error: 'Expected a valid http(s) url, title, and currentTime' });
  lastError = null;
  lastCast = { type: 'cast', url: b.url, title: b.title.slice(0, 300), pageUrl: String(b.pageUrl || '').slice(0, 2048), mediaType: String(b.type || ''), currentTime: Math.max(0, Number(b.currentTime || 0)), sentAt: Date.now() };
  broadcast(lastCast); log('info', 'cast', { title: lastCast.title, tvs: clients.size });
  res.json({ ok: true, codecWarning: codecWarning(b.url) });
});
app.post('/control', auth, function (req, res) {
  var b = req.body || {}, allowed = ['play', 'pause', 'seek', 'volume', 'volumeUp', 'volumeDown', 'stop'];
  if (allowed.indexOf(b.action) < 0 || (b.action === 'seek' && !isFinite(Number(b.value))) || (b.action === 'volume' && (!isFinite(Number(b.value)) || Number(b.value) < 0 || Number(b.value) > 1))) return res.status(400).json({ error: 'Invalid control action or value' });
  if (b.action === 'stop') { lastCast = null; stopAllMirrors('Stopped by remote control'); }
  broadcast({ type: 'control', action: b.action, value: b.value }); res.json({ ok: true });
});
app.get('/status', function (req, res) { res.json({ connectedTVs: clients.size, currentVideo: lastCast, lastTVError: lastError, lastTVState: lastTVState }); });

function stopMirror(id, reason) {
  var item = mirrors[id]; if (!item || item.state === 'stopped') return;
  item.state = 'stopped'; item.error = reason || '';
  if (item.ws && item.ws.readyState === WebSocket.OPEN) item.ws.close(1000, 'Mirror stopped');
  if (item.ffmpeg && item.ffmpeg.stdin && !item.ffmpeg.stdin.destroyed) item.ffmpeg.stdin.end();
  if (activeMirrorId === id) activeMirrorId = null;
  if (lastCast && lastCast.mirrorId === id) lastCast = null;
  setTimeout(function () { fs.rm(item.dir, { recursive: true, force: true }, function () {}); delete mirrors[id]; }, 30000).unref();
}
function stopAllMirrors(reason) { Object.keys(mirrors).forEach(function (id) { stopMirror(id, reason); }); }
function startFfmpeg(item, mime) {
  if (item.ffmpeg) return;
  var playlist = path.join(item.dir, 'index.m3u8');
  var segment = path.join(item.dir, 'seg-%05d.ts');
  var args = ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=w='min(1280,iw)':h=-2,fps=25", '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p', '-b:v', '2200k', '-maxrate', '2500k', '-bufsize', '4400k', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '8', '-hls_delete_threshold', '3', '-hls_version', '3', '-hls_flags', 'delete_segments+omit_endlist', '-hls_segment_filename', segment, playlist];
  item.ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  item.ffmpeg.stderr.on('data', function (chunk) { item.log = (item.log + chunk.toString()).slice(-2000); });
  item.ffmpeg.on('spawn', function () { item.state = 'recording'; if (item.ws && item.ws.readyState === WebSocket.OPEN) item.ws.send(JSON.stringify({ type: 'ready' })); });
  item.ffmpeg.on('error', function (error) { item.state = 'error'; item.error = 'Could not start ffmpeg: ' + error.message; if (item.ws && item.ws.readyState === WebSocket.OPEN) item.ws.send(JSON.stringify({ type: 'error', message: item.error })); });
  item.ffmpeg.on('close', function (code) { if (item.state !== 'stopped' && code !== 0) { item.state = 'error'; item.error = 'ffmpeg exited with code ' + code + ': ' + item.log.slice(-500); } });
  var waited = 0;
  item.readyPoll = setInterval(function () {
    waited += 250;
    if (fs.existsSync(playlist) && fs.readdirSync(item.dir).some(function (f) { return /^seg-\d+\.ts$/.test(f); }) && !item.castSent) {
      item.castSent = true;
      var streamUrl = 'http://' + (item.host || '127.0.0.1') + ':' + PORT + '/mirror/' + item.id + '/index.m3u8';
      lastCast = { type: 'cast', mirrorId: item.id, url: streamUrl, title: 'Chrome tab mirror', pageUrl: '', mediaType: 'application/vnd.apple.mpegurl', currentTime: 0, sentAt: Date.now() };
      broadcast(lastCast); log('info', 'mirror_ready', { id: item.id, tvs: clients.size }); clearInterval(item.readyPoll);
    } else if (waited >= 15000) {
      clearInterval(item.readyPoll);
      if (!item.castSent && item.state !== 'error') {
        item.state = 'error'; item.error = 'The PC encoder did not produce playable HLS. The captured tab stream may be unsupported or protected.';
        if (item.ws && item.ws.readyState === WebSocket.OPEN) item.ws.send(JSON.stringify({ type: 'error', message: item.error }));
      }
    } else if (item.state === 'error') clearInterval(item.readyPoll);
  }, 250);
}
app.post('/mirror/start', auth, function (req, res) {
  if (!clients.size) return res.status(409).json({ error: 'Open HomeCast on the TV and connect it before starting mirror mode.' });
  stopAllMirrors('Replaced by a new mirror session');
  var id = crypto.randomBytes(16).toString('hex');
  var dir = path.join(os.tmpdir(), 'homecast-mirror-' + id);
  fs.mkdir(dir, { recursive: true }, function (error) {
    if (error) return res.status(500).json({ error: 'Could not create mirror session files.' });
    var item = { id: id, dir: dir, state: 'waiting-capture', error: '', log: '', ffmpeg: null, ws: null, host: (req.get('host') || '127.0.0.1').split(':')[0] };
    mirrors[id] = item; activeMirrorId = id;
    res.json({ ok: true, sessionId: id });
  });
});
app.get('/mirror/status/:id', auth, function (req, res) {
  var item = mirrors[req.params.id];
  if (!item) return res.status(404).json({ error: 'Mirror session expired' });
  res.json({ state: item.state, error: item.error, ffmpeg: !!item.ffmpeg });
});
app.post('/mirror/stop', auth, function (req, res) {
  var b = req.body || {};
  if (b.sessionId && mirrors[b.sessionId]) stopMirror(b.sessionId, String(b.reason || 'Stopped by user').slice(0, 300));
  else stopAllMirrors(String(b.reason || 'Stopped by user').slice(0, 300));
  res.json({ ok: true });
});
app.get('/mirror/:id/:file', function (req, res) {
  var item = mirrors[req.params.id];
  if (!item || !/^(index\.m3u8|seg-\d+\.ts)$/.test(req.params.file)) return res.status(404).end();
  var file = path.join(item.dir, req.params.file);
  fs.stat(file, function (error, stat) {
    if (error || !stat.isFile()) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type(req.params.file === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    fs.createReadStream(file).pipe(res);
  });
});

// Resolve and reject non-public addresses before opening outbound proxy requests.
function isPrivate(ip) {
  var mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) { var p = ip.split('.').map(Number); return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224; }
  return ip === '::1' || ip === '::' || /^fe[89ab]/i.test(ip) || /^f[cd]/i.test(ip) || /^2001:db8:/i.test(ip);
}
async function safeTarget(raw) {
  var u = new URL(raw);
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw new Error('Only public HTTP(S) URLs are allowed');
  var addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(function (a) { return isPrivate(a.address); })) throw new Error('Private, loopback, or link-local destinations are blocked');
  u._homecastAddress = addrs[0].address;
  return u;
}
function upstream(u, req, res, depth) {
  var mod = u.protocol === 'https:' ? https : httpClient;
  var headers = { 'User-Agent': req.get('user-agent') || 'HomeCast/1.0 (LAN media proxy)', 'Accept': req.get('accept') || '*/*' };
  if (req.get('range')) headers.Range = req.get('range');
  if (req.query.referer) { try { var ref = new URL(req.query.referer); if (ref.protocol === 'https:' || ref.protocol === 'http:') headers.Referer = ref.href; } catch (_) {} }
  if (req.query.origin) { try { var origin = new URL(req.query.origin); if ((origin.protocol === 'https:' || origin.protocol === 'http:') && origin.origin === req.query.origin.replace(/\/$/, '')) headers.Origin = origin.origin; } catch (_) {} }
  var out = mod.get(u, { headers: headers, timeout: 15000, lookup: function (hostname, options, callback) {
    // Node may request a single result or the `{ all: true }` array form.
    // Match the callback shape exactly while keeping the DNS result pinned.
    if (typeof options === 'function') { callback = options; options = {}; }
    var address = u._homecastAddress, family = net.isIP(address);
    if (!family) return callback(new Error('Could not pin a public upstream address'));
    if (options && options.all) return callback(null, [{ address: address, family: family }]);
    callback(null, address, family);
  } }, function (up) {
    res.status(up.statusCode || 502);
    var isPlaylist = /mpegurl/i.test(up.headers['content-type'] || '') || /\.m3u8(?:$|\?)/i.test(u.pathname);
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach(function (h) {
      if (up.headers[h] && !(isPlaylist && (h === 'content-length' || h === 'content-range' || h === 'accept-ranges'))) res.setHeader(h, up.headers[h]);
    });
    if (isPlaylist) {
      var body = ''; up.setEncoding('utf8'); up.on('data', function (part) { body += part; });
      up.on('end', function () { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(body.split(/\r?\n/).map(function (line) {
        function rewriteUri(uri) {
          var resolved = new URL(uri, u);
          // Some CDNs place the stream signature on the playlist URL and omit it on segment paths.
          if (!resolved.search && u.search) resolved.search = u.search;
          var rewritten = '/proxy?url=' + encodeURIComponent(resolved.href) + '&referer=' + encodeURIComponent(req.query.referer || u.href);
          if (req.query.origin) rewritten += '&origin=' + encodeURIComponent(req.query.origin);
          return rewritten;
        }
        if (!line || line.charAt(0) === '#') return line.replace(/URI="([^"]+)"/g, function (_, uri) { return 'URI="' + rewriteUri(uri) + '"'; });
        try { return rewriteUri(line); } catch (_) { return line; }
      }).join('\n')); });
    } else up.pipe(res);
  });
  out.on('error', function (e) { if (!res.headersSent) res.status(502).json({ error: e.message }); else res.destroy(); });
}
app.get(['/proxy', '/proxy/playlist.m3u8'], async function (req, res) {
  try {
    var url = req.query.url;
    if (!url || url.length > 4096) return res.status(400).json({ error: 'Missing or oversized url' });
    var u = await safeTarget(url);
    var key = req.socket.remoteAddress || 'unknown', now = Date.now(); rateMap[key] = (rateMap[key] || []).filter(function (t) { return now - t < 60000; });
    if (rateMap[key].length > 120) return res.status(429).end(); rateMap[key].push(now);
    upstream(u, req, res);
  } catch (e) { res.status(403).json({ error: e.message }); }
});
app.get('/transcode', function (req, res) { res.status(501).json({ error: 'Optional transcoding is not configured. Install ffmpeg and add a bounded, managed HLS transcoding worker before enabling this endpoint.' }); });
server.on('upgrade', function (req, socket, head) {
  var parsed = new URL(req.url, 'http://localhost');
  if ((parsed.pathname !== '/ws' && parsed.pathname !== '/mirror/ws') || (TOKEN && parsed.searchParams.get('token') !== TOKEN)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, function (ws) { wss.emit('connection', ws, req); });
});
wss.on('connection', function (ws, req) {
  var parsed = new URL(req.url, 'http://localhost');
  if (parsed.pathname === '/mirror/ws') {
    var item = mirrors[parsed.searchParams.get('session')];
    if (!item || item.ws) { ws.close(1008, 'Invalid or active mirror session'); return; }
    item.ws = ws; item.state = 'connecting';
    ws.on('message', function (raw, isBinary) {
      if (isBinary) {
        if (item.ffmpeg && item.state === 'recording' && item.ffmpeg.stdin && !item.ffmpeg.stdin.destroyed) {
          if (item.ffmpeg.stdin.writableLength > 8 * 1024 * 1024) { item.error = 'Encoder cannot keep up; reduce source resolution or frame rate.'; return stopMirror(item.id, item.error); }
          item.ffmpeg.stdin.write(raw);
        }
        return;
      }
      try { var message = JSON.parse(raw.toString()); if (message.type === 'start') startFfmpeg(item, String(message.mime || '').slice(0, 100)); else if (message.type === 'error') { item.error = String(message.message || 'Capture failed').slice(0, 500); item.state = 'error'; } }
      catch (_) {}
    });
    ws.on('close', function () { if (item.state !== 'stopped' && item.state !== 'error') stopMirror(item.id, 'Browser capture disconnected'); });
    ws.on('error', function (error) { item.error = error.message; });
    return;
  }
  clients.add(ws); ws.isAlive = true; ws.on('pong', function () { ws.isAlive = true; });
  ws.on('message', function (raw) { try {
    var m = JSON.parse(raw);
    if (m.type === 'error') { lastError = { message: String(m.message || 'TV playback error').slice(0, 500), time: Date.now() }; log('warn', 'tv_error', lastError); }
    else if (m.type === 'state') {
      lastTVState = { state: String(m.state || '').slice(0, 50), currentTime: isFinite(Number(m.currentTime)) ? Number(m.currentTime) : null, volume: isFinite(Number(m.volume)) ? Number(m.volume) : null, title: String(m.title || (lastCast && lastCast.title) || '').slice(0, 300), time: Date.now() };
      if (m.state === 'playing') lastError = null;
      if (m.state === 'stopped') { lastCast = null; stopAllMirrors('Stopped on TV'); }
      log('info', 'tv_state', lastTVState);
    }
  } catch (_) {} });
  ws.on('close', function () { clients.delete(ws); }); ws.on('error', function () { clients.delete(ws); });
  if (lastCast) ws.send(JSON.stringify(lastCast));
});
var heartbeat = setInterval(function () { clients.forEach(function (ws) { if (!ws.isAlive) { clients.delete(ws); return ws.terminate(); } ws.isAlive = false; ws.ping(); }); }, 25000);
server.listen(PORT, '0.0.0.0', function () {
  var ips = []; Object.keys(os.networkInterfaces()).forEach(function (name) { (os.networkInterfaces()[name] || []).forEach(function (item) { if (item.family === 'IPv4' && !item.internal) ips.push(item.address); }); });
  log('info', 'ready', { port: PORT, addresses: ips.map(function (ip) { return 'http://' + ip + ':' + PORT; }) });
});
function shutdown() { clearInterval(heartbeat); clients.forEach(function (ws) { ws.close(1001, 'Server shutting down'); }); server.close(function () { process.exit(0); }); setTimeout(function () { process.exit(1); }, 5000).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
