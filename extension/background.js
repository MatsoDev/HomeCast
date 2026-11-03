'use strict';

var CAPTURE_TTL = 120000;
var CAPTURE_KEY = 'homecastCaptureByTab';

function classifyUrl(url) {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  if (/\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (/\.mp4(?:[?#]|$)/i.test(url)) return 'mp4';
  if (/\.(ts|m4s|m4v)(?:[?#]|$)/i.test(url)) return 'segment';
  return '';
}

function rememberRequest(details, mime, requestHeaders) {
  if (details.tabId < 0) return;
  chrome.storage.session.get(CAPTURE_KEY, function (state) {
    var captures = state[CAPTURE_KEY] || {};
    var capture = captures[details.tabId];
    if (!capture || capture.expiresAt < Date.now()) return;
    var kind = classifyUrl(details.url);
    if (!kind && mime) {
      if (/mpegurl/i.test(mime)) kind = 'hls';
      else if (/dash\+xml/i.test(mime)) kind = 'dash';
      else if (/^video\/mp4/i.test(mime)) kind = 'mp4';
      else if (/mpeg2?-ts|mp2t|iso\.segment/i.test(mime)) kind = 'segment';
    }
    if (!kind) return;
    var capturedReferer = '', capturedOrigin = '';
    (requestHeaders || []).forEach(function (header) {
      if (header.name.toLowerCase() === 'referer') capturedReferer = String(header.value || '').slice(0, 2048);
      if (header.name.toLowerCase() === 'origin') capturedOrigin = String(header.value || '').slice(0, 512);
    });
    capture.requestCount += 1;
    if (kind === 'segment') capture.segmentCount += 1;
    else {
      var key = kind + '|' + details.url;
      var found = null;
      capture.candidates.some(function (candidate) { if (candidate.key === key) { found = candidate; return true; } return false; });
      if (!found) { found = { key: key, kind: kind, url: details.url, time: Date.now() }; capture.candidates.push(found); }
      if (capturedReferer) found.referer = capturedReferer;
      if (capturedOrigin) found.origin = capturedOrigin;
      capture.candidates.sort(function (a, b) {
        var rank = { hls: 4, mp4: 3, dash: 1 };
        return rank[b.kind] - rank[a.kind] || b.time - a.time;
      });
      capture.candidates = capture.candidates.slice(0, 30);
    }
    captures[details.tabId] = capture;
    var update = {}; update[CAPTURE_KEY] = captures;
    chrome.storage.session.set(update);
  });
}

// MV3 listeners are registered at service worker startup. They only store
// short lived media URL metadata while a user explicitly armed a tab capture.
chrome.webRequest.onBeforeRequest.addListener(function (details) {
  if (classifyUrl(details.url)) rememberRequest(details, '');
}, { urls: ['http://*/*', 'https://*/*'] });

chrome.webRequest.onHeadersReceived.addListener(function (details) {
  var contentType = '';
  (details.responseHeaders || []).forEach(function (header) {
    if (header.name.toLowerCase() === 'content-type') contentType = String(header.value || '').split(';')[0];
  });
  if (contentType) rememberRequest(details, contentType);
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

chrome.webRequest.onBeforeSendHeaders.addListener(function (details) {
  rememberRequest(details, '', details.requestHeaders || []);
}, { urls: ['http://*/*', 'https://*/*'] }, ['requestHeaders', 'extraHeaders']);

chrome.runtime.onMessage.addListener(function (message, sender, reply) {
  if (message && message.type === 'homecast-mirror-update') {
    var status = message.status || {};
    chrome.storage.session.set({ mirrorStatus: { state: status.state || '', error: status.error || '', sessionId: status.sessionId || '' } });
    if (status.state === 'error' && status.server) {
      fetch(status.server.replace(/\/+$/, '') + '/mirror/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pairing-Token': status.token || '' }, body: JSON.stringify({ sessionId: status.sessionId, reason: status.error || 'Chrome tab capture failed' }) }).catch(function () {});
    }
    return;
  }
  if (message && message.type === 'homecast-arm-capture' && Number.isInteger(message.tabId)) {
    chrome.storage.session.get(CAPTURE_KEY, function (state) {
      var captures = state[CAPTURE_KEY] || {};
      captures[message.tabId] = { startedAt: Date.now(), expiresAt: Date.now() + CAPTURE_TTL, requestCount: 0, segmentCount: 0, candidates: [] };
      var update = {}; update[CAPTURE_KEY] = captures;
      chrome.storage.session.set(update, function () {
        chrome.tabs.reload(message.tabId, function () {
          if (chrome.runtime.lastError) reply({ error: chrome.runtime.lastError.message });
          else reply({ ok: true, expiresAt: captures[message.tabId].expiresAt });
        });
      });
    });
    return true;
  }
  if (message && message.type === 'homecast-get-capture' && Number.isInteger(message.tabId)) {
    chrome.storage.session.get(CAPTURE_KEY, function (state) {
      var capture = (state[CAPTURE_KEY] || {})[message.tabId] || null;
      if (capture && capture.expiresAt < Date.now()) capture = null;
      reply({ capture: capture });
    });
    return true;
  }
  if (message && message.type === 'remember-stream' && sender.tab) {
    chrome.storage.session.get('streamsByTab', function (state) {
      var streams = state.streamsByTab || {};
      var id = sender.tab.id;
      streams[id] = (streams[id] || []).filter(function (entry) { return entry.url !== message.url; });
      streams[id].unshift({ url: message.url, time: Date.now() });
      streams[id] = streams[id].slice(0, 20);
      chrome.storage.session.set({ streamsByTab: streams });
    });
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  chrome.storage.session.get([CAPTURE_KEY, 'streamsByTab'], function (state) {
    var captures = state[CAPTURE_KEY] || {}, streams = state.streamsByTab || {};
    delete captures[tabId]; delete streams[tabId];
    var update = {}; update[CAPTURE_KEY] = captures; update.streamsByTab = streams;
    chrome.storage.session.set(update);
  });
});
