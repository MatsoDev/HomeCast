'use strict';
var $ = function (id) { return document.getElementById(id); };
var serverInput = $('server'), tokenInput = $('token'), message = $('message'), statusNode = $('status');
var activeTabId = null, activePageUrl = '', detectedCandidates = [], selectedCandidate = null, capturePoll = null, mirrorSessionId = '';

chrome.storage.local.get(['server', 'token', 'mirrorSessionId'], function (data) {
  serverInput.value = data.server || ''; tokenInput.value = data.token || ''; checkStatus();
  mirrorSessionId = data.mirrorSessionId || '';
  if (mirrorSessionId) updateMirrorStatus();
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs[0]) return;
    activeTabId = tabs[0].id; activePageUrl = tabs[0].url || '';
    refreshCapture();
  });
});
function base() { return serverInput.value.replace(/\/+$/, ''); }
function headers() { return { 'Content-Type': 'application/json', 'X-Pairing-Token': tokenInput.value }; }
function save() { chrome.storage.local.set({ server: base(), token: tokenInput.value }); }
serverInput.addEventListener('change', save); tokenInput.addEventListener('change', save);
function request(path, options, done) {
  fetch(base() + path, options).then(function (r) { return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status)); return body; }); }).then(done).catch(function (e) { message.textContent = e.message; statusNode.textContent = 'Server unavailable'; });
}
function allowServer(done) {
  try {
    var parsed = new URL(base());
    chrome.permissions.request({ origins: [parsed.protocol + '//' + parsed.hostname + '/*'] }, function (granted) {
      if (!granted) { announce('Allow HomeCast access to this server address in Chrome.'); return; }
      done();
    });
  } catch (e) { announce('Enter a valid server URL, including http:// and port.'); }
}
function checkStatus() {
  if (!base()) { statusNode.textContent = 'Set the PC server address'; return; }
  var parsed;
  try { parsed = new URL(base()); } catch (e) { statusNode.textContent = 'Enter a valid server address'; return; }
  chrome.permissions.contains({ origins: [parsed.protocol + '//' + parsed.hostname + '/*'] }, function (ok) {
    if (!ok) { statusNode.textContent = 'Cast once to grant server access'; return; }
    request('/status', { headers: headers() }, function (s) { statusNode.textContent = 'Server online · ' + s.connectedTVs + ' TV connected' + (s.lastTVError ? ' · TV: ' + s.lastTVError.message : ''); });
  });
}
function announce(text) { message.textContent = text; }
function updateMirrorStatus() {
  if (!mirrorSessionId || !base()) return;
  request('/mirror/status/' + encodeURIComponent(mirrorSessionId), { headers: headers() }, function (state) {
    $('mirrorStatus').textContent = state.error || ('Mirror: ' + state.state);
    if (state.state === 'stopped' || state.state === 'error') { mirrorSessionId = ''; chrome.storage.local.remove('mirrorSessionId'); }
  });
}
function startMirror() {
  save();
  $('mirrorStatus').textContent = 'Preparing tab capture…';
  announce('Allow Chrome to open its tab picker.');
  if (!base()) return announce('Enter the PC server address first.');
  if (/^(chrome|edge|about|chrome-extension):/i.test(activePageUrl)) return announce('Chrome internal and extension pages cannot be mirrored. Open a regular website tab first.');
  chrome.permissions.request({ permissions: ['desktopCapture'] }, function (capturePermission) {
    if (!capturePermission) return announce('Tab capture permission was declined.');
    allowServer(function () {
      fetch(base() + '/mirror/start', { method: 'POST', headers: headers(), body: '{}' }).then(function (r) {
        return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status)); return body; });
      }).then(function (session) {
        mirrorSessionId = session.sessionId;
        var launch = { sessionId: session.sessionId, server: base(), token: tokenInput.value };
        chrome.storage.local.set({ mirrorSessionId: mirrorSessionId, mirrorLaunch: launch }, function () {
          chrome.windows.create({ url: chrome.runtime.getURL('mirror.html'), type: 'popup', width: 390, height: 230 }, function (win) {
            if (chrome.runtime.lastError || !win) {
              fetch(base() + '/mirror/stop', { method: 'POST', headers: headers(), body: JSON.stringify({ sessionId: session.sessionId, reason: 'Could not open the mirror capture window' }) });
              mirrorSessionId = ''; chrome.storage.local.remove(['mirrorSessionId', 'mirrorLaunch']);
              return announce(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Could not open the mirror capture window.');
            }
            $('mirrorStatus').textContent = 'Chrome capture window opened…';
            announce('Use the Chrome capture window to select the tab.');
            if (!window.mirrorTimer) window.mirrorTimer = window.setInterval(updateMirrorStatus, 2000);
          });
        });
      }).catch(function (error) { announce(error.message); });
    });
  });
}
$('mirror').addEventListener('click', startMirror);
function refreshCapture() {
  if (activeTabId === null) return;
  chrome.runtime.sendMessage({ type: 'homecast-get-capture', tabId: activeTabId }, function (reply) {
    if (chrome.runtime.lastError || !reply || !reply.capture) return;
    renderCapture(reply.capture);
    if (!reply.capture.candidates.length && reply.capture.expiresAt > Date.now() && !capturePoll) {
      capturePoll = window.setInterval(refreshCapture, 1500);
      window.setTimeout(function () { if (capturePoll) { window.clearInterval(capturePoll); capturePoll = null; } }, Math.min(120000, reply.capture.expiresAt - Date.now()));
    }
  });
}
function renderCapture(capture) {
  var select = $('detected'), label = $('detectedLabel'), previous = select.value;
  detectedCandidates = capture.candidates || [];
  while (select.firstChild) select.removeChild(select.firstChild);
  if (!detectedCandidates.length) {
    var empty = document.createElement('option'); empty.value = ''; empty.textContent = 'No MP4/HLS found yet'; select.appendChild(empty);
    selectedCandidate = null; label.className = 'detected';
    if (capture.segmentCount) announce('Saw ' + capture.segmentCount + ' media segment requests, but no direct MP4/HLS playlist.');
    else announce('Watching this page for up to 2 minutes…');
    return;
  }
  detectedCandidates.forEach(function (candidate, index) {
    var option = document.createElement('option'); option.value = String(index);
    option.textContent = candidate.kind.toUpperCase() + ' · ' + (new URL(candidate.url)).hostname + (candidate.kind === 'dash' ? ' · unsupported' : '');
    select.appendChild(option);
  });
  if (previous && Number(previous) < detectedCandidates.length) select.value = previous;
  selectedCandidate = detectedCandidates[Number(select.value) || 0];
  label.className = 'detected';
  announce('Captured ' + detectedCandidates.length + ' stream URL(s). Choose one, then Cast.');
}
$('detected').addEventListener('change', function () { selectedCandidate = detectedCandidates[Number(this.value)] || null; });
$('capture').addEventListener('click', function () {
  save();
  if (activeTabId === null) return announce('No active tab found.');
  announce('Chrome will ask for optional access to observe requests for this capture.');
  chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }, function (granted) {
    if (!granted) return announce('Network capture permission was declined. No page was reloaded.');
    chrome.runtime.sendMessage({ type: 'homecast-arm-capture', tabId: activeTabId }, function (reply) {
      if (chrome.runtime.lastError || !reply || reply.error) return announce((reply && reply.error) || chrome.runtime.lastError.message);
      announce('Capture armed; page reloaded. Reopen HomeCast after the player starts to choose a stream.');
    });
  });
});
function castCandidate(candidate) {
  if (!candidate) return false;
  if (candidate.kind === 'dash') { announce('This TV app cannot play MPEG-DASH directly.'); return true; }
  if (candidate.kind !== 'hls' && candidate.kind !== 'mp4') { announce('This request is a media segment, not a castable playlist/file.'); return true; }
  var upstreamReferer = candidate.referer || activePageUrl;
  var proxyUrl = base() + (candidate.kind === 'hls' ? '/proxy/playlist.m3u8' : '/proxy') + '?url=' + encodeURIComponent(candidate.url) + '&referer=' + encodeURIComponent(upstreamReferer);
  if (candidate.origin) proxyUrl += '&origin=' + encodeURIComponent(candidate.origin);
  var payload = { url: proxyUrl, title: document.title || 'Captured video', pageUrl: activePageUrl, type: candidate.kind === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4', currentTime: 0 };
  allowServer(function () { request('/cast', { method: 'POST', headers: headers(), body: JSON.stringify(payload) }, function (reply) { announce(reply.codecWarning || 'Captured stream sent to the TV.'); checkStatus(); }); });
  return true;
}
function grantFrameAccess(tabId, done) {
  var visited = [], passes = 0;
  function discover() {
    passes += 1;
    chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, func: function () {
      var origins = [];
      Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (frame) {
        var rect = frame.getBoundingClientRect();
        if (rect.width * rect.height < 30000) return;
        try { var url = new URL(frame.src, location.href); if (url.protocol === 'http:' || url.protocol === 'https:') origins.push(url.origin); } catch (ignore) {}
      });
      return origins;
    } }, function (rows) {
      if (chrome.runtime.lastError || !rows) return done(visited.length > 0);
      var needed = [];
      rows.forEach(function (row) { (row.result || []).forEach(function (origin) { if (visited.indexOf(origin) < 0 && needed.indexOf(origin) < 0) needed.push(origin); }); });
      needed = needed.slice(0, 8);
      if (!needed.length || passes >= 4) return done(true);
      needed.forEach(function (origin) { visited.push(origin); });
      chrome.permissions.request({ origins: needed.map(function (origin) { return origin + '/*'; }) }, function (granted) {
        if (chrome.runtime.lastError || !granted) return done(visited.length > 0);
        discover();
      });
    });
  }
  discover();
}
$('cast').addEventListener('click', function () {
  save(); announce('Scanning this tab…');
  if (!base()) return announce('Enter the server address first.');
  if (selectedCandidate && castCandidate(selectedCandidate)) return;
  allowServer(function () {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs[0]) return announce('No active tab found.');
      activeTabId = tabs[0].id; activePageUrl = tabs[0].url || '';
      grantFrameAccess(tabs[0].id, function () {
        chrome.scripting.executeScript({ target: { tabId: tabs[0].id, allFrames: true }, files: ['inject.js'] }, function () {
          if (chrome.runtime.lastError) return announce(chrome.runtime.lastError.message);
          chrome.scripting.executeScript({ target: { tabId: tabs[0].id, allFrames: true }, func: function () { return typeof window.__homecastScan === 'function' ? window.__homecastScan() : { empty: true }; } }, function (frames) {
            if (chrome.runtime.lastError) return announce('Could not scan page: ' + chrome.runtime.lastError.message);
            var candidates = (frames || []).map(function (x) { return x.result; }).filter(function (x) { return x && x.url; });
            candidates.sort(function (a, b) { return a.score - b.score; });
            var result = candidates[candidates.length - 1];
            if (!result) {
              var results = (frames || []).map(function (x) { return x.result || {}; });
              if (results.some(function (x) { return x.dash; })) return announce('This player requested MPEG-DASH (.mpd), which this TV app cannot play natively.');
              if (results.some(function (x) { return x.segments; })) return announce('The player exposes media segments but no MP4/HLS playlist. Try Reload & detect stream.');
              return announce(results.some(function (x) { return x.blob; }) ? 'The player uses a blob URL. Try Reload & detect stream before playback starts.' : 'No direct MP4/HLS stream found. Try Reload & detect stream.');
            }
            if (!/^https?:/i.test(result.url)) return announce('The video has no directly reachable HTTP(S) stream.');
            if (result.viaProxy) result.url = base() + (result.type === 'application/vnd.apple.mpegurl' ? '/proxy/playlist.m3u8' : '/proxy') + '?url=' + encodeURIComponent(result.url) + '&referer=' + encodeURIComponent(result.pageUrl);
            delete result.score; delete result.viaProxy;
            request('/cast', { method: 'POST', headers: headers(), body: JSON.stringify(result) }, function (reply) { announce(reply.codecWarning || ('Casting “' + result.title + '”')); checkStatus(); });
          });
        });
      });
    });
  });
});
$('capture').addEventListener('click', function () {
  if (capturePoll) window.clearInterval(capturePoll);
  capturePoll = window.setInterval(refreshCapture, 1500);
  window.setTimeout(function () { if (capturePoll) { window.clearInterval(capturePoll); capturePoll = null; } }, 120000);
});
Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (button) {
  button.addEventListener('click', function () {
    request('/control', { method: 'POST', headers: headers(), body: JSON.stringify({ action: button.getAttribute('data-action'), value: Number(button.getAttribute('data-value')) }) }, function () {
      announce('Control sent.');
      if (button.getAttribute('data-action') === 'stop') { mirrorSessionId = ''; chrome.storage.local.remove('mirrorSessionId'); $('mirrorStatus').textContent = 'Mirror stopped'; }
    });
  });
});
