'use strict';
// Runs in each accessible frame. Resource Timing exposes requested media URLs
// even when the player assigns a blob: URL to its <video> element.
window.__homecastScan = function () {
  var list = Array.prototype.slice.call(document.querySelectorAll('video'));
  list.sort(function (a, b) {
    var aa = (a.videoWidth || a.clientWidth) * (a.videoHeight || a.clientHeight) + (a.paused ? 0 : 1e12);
    var bb = (b.videoWidth || b.clientWidth) * (b.videoHeight || b.clientHeight) + (b.paused ? 0 : 1e12);
    return aa - bb;
  });
  var video = list[list.length - 1];
  var direct = video ? (video.currentSrc || video.src || '') : '';
  var isBlob = /^blob:/i.test(direct);
  if (direct && !isBlob && /^https?:/i.test(direct)) {
    return {
      url: direct,
      title: document.title || 'Video',
      pageUrl: location.href,
      type: video.getAttribute('type') || '',
      currentTime: video.currentTime || 0,
      score: 1e16 + (video.paused ? 0 : 1e12) + (video.videoWidth || video.clientWidth) * (video.videoHeight || video.clientHeight),
      viaProxy: false
    };
  }
  var entries = [];
  try { entries = window.performance && performance.getEntriesByType ? performance.getEntriesByType('resource') : []; } catch (ignore) {}
  var best = null, sawSegment = false, sawDash = false;
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i].name || '';
    if (!/^https?:/i.test(name)) continue;
    var matchName = name;
    try { matchName = decodeURIComponent(name); } catch (ignoreDecode) {}
    if (/\.mpd(?:[?#]|$)|(?:format|type)=[^&#]*mpd/i.test(matchName)) sawDash = true;
    if (/\.(ts|m4s|m4v)(?:[?#]|$)/i.test(matchName)) sawSegment = true;
    if (/\.m3u8(?:[?#]|$)|(?:format|type|mime)=[^&#]*(m3u8|mpegurl|hls)/i.test(matchName)) {
      if (!best || !best.hls || entries[i].startTime > best.startTime) best = { url: name, hls: true, startTime: entries[i].startTime || 0 };
    } else if (/\.mp4(?:[?#]|$)|(?:format|type|mime)=[^&#]*(mp4|video%2fmp4)/i.test(matchName) && (!best || (!best.hls && entries[i].startTime > best.startTime))) {
      best = { url: name, hls: false, startTime: entries[i].startTime || 0 };
    }
  }
  if (best) {
    return {
      url: best.url,
      title: document.title || 'Video',
      pageUrl: location.href,
      type: best.hls ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      currentTime: video ? (video.currentTime || 0) : 0,
      score: 1e15 + (best.hls ? 1e12 : 0) + best.startTime,
      viaProxy: true
    };
  }
  return { empty: true, blob: isBlob, dash: sawDash, segments: sawSegment, frame: location.href };
};
