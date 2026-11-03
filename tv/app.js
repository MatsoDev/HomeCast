'use strict';
(function () {
  var player = document.getElementById('player');
  var idle = document.getElementById('idle');
  var connection = document.getElementById('connection');
  var overlay = document.getElementById('overlay');
  var settings = document.getElementById('settings');
  var host = document.getElementById('host');
  var port = document.getElementById('port');
  var token = document.getElementById('token');
  var socket = null;
  var retry = 1000;
  var overlayTimer = null;
  var stallTimer = null;
  var lastProgressReport = 0;
  var lastCast = null;
  var config = {};
  try { config = JSON.parse(localStorage.getItem('homecastConfig') || '{}'); } catch (e) { config = {}; }
  host.value = config.host || '';
  port.value = config.port || '3000';
  token.value = config.token || '';
  function send(type, data) { if (socket && socket.readyState === 1) { data = data || {}; data.type = type; socket.send(JSON.stringify(data)); } }
  function report(message) { send('error', { message: String(message || 'Playback failed') }); connection.innerHTML = 'Playback error: ' + String(message || '').replace(/[<>]/g, ''); }
  function connect() {
    if (!config.host) { connection.innerHTML = 'Open Settings to enter the PC server address'; return; }
    try { socket = new WebSocket('ws://' + config.host + ':' + config.port + '/ws?token=' + encodeURIComponent(config.token || '')); }
    catch (e) { connection.innerHTML = 'Invalid server address'; return schedule(); }
    connection.innerHTML = 'Connecting to ' + config.host + '…';
    socket.onopen = function () { retry = 1000; connection.innerHTML = 'Connected to HomeCast server'; send('state', { state: 'ready' }); };
    socket.onmessage = function (event) { var m; try { m = JSON.parse(event.data); } catch (e) { return; } if (m.type === 'cast') playCast(m); else if (m.type === 'control') control(m); };
    socket.onclose = function () { connection.innerHTML = 'Disconnected · reconnecting…'; schedule(); };
    socket.onerror = function () { connection.innerHTML = 'Connection error'; };
  }
  function schedule() { window.setTimeout(connect, retry); retry = Math.min(retry * 2, 30000); }
  function playCast(m) {
    lastCast = m; player.src = m.url; player.currentTime = Math.max(0, Number(m.currentTime || 0));
    document.getElementById('title').innerHTML = String(m.title || 'HomeCast').replace(/[<>]/g, '');
    idle.className = 'hidden'; player.style.display = 'block'; showOverlay();
    var result = player.play(); if (result && typeof result.catch === 'function') result.catch(function (e) { report(e.message || 'The TV could not start this stream'); });
    send('state', { state: 'playing', title: m.title });
  }
  function stopPlayback() {
    clearStallTimer();
    lastCast = null;
    player.pause(); player.removeAttribute('src'); player.load(); player.style.display = 'none';
    idle.className = ''; overlay.className = '';
    document.getElementById('bar').style.width = '0%';
    document.getElementById('time').innerHTML = '';
    document.getElementById('volume').innerHTML = '';
    send('state', { state: 'stopped' });
  }
  function togglePlayback() {
    if (player.paused) {
      var result = player.play();
      if (result && typeof result.catch === 'function') result.catch(function (e) { report(e.message || 'The TV could not resume this stream'); });
    } else player.pause();
    showOverlay();
  }
  function control(m) {
    if (m.action === 'stop') { stopPlayback(); return; }
    else if (m.action === 'play') player.play();
    else if (m.action === 'pause') player.pause();
    else if (m.action === 'seek') player.currentTime = Math.max(0, player.currentTime + Number(m.value || 0));
    else if (m.action === 'volume') player.volume = Math.max(0, Math.min(1, Number(m.value)));
    else if (m.action === 'volumeUp') player.volume = Math.min(1, player.volume + 0.1);
    else if (m.action === 'volumeDown') player.volume = Math.max(0, player.volume - 0.1);
    if (m.action === 'volume' || m.action === 'volumeUp' || m.action === 'volumeDown') {
      document.getElementById('volume').innerHTML = 'Video volume: ' + Math.round(player.volume * 100) + '%';
      send('state', { state: player.paused ? 'paused' : 'playing', currentTime: player.currentTime, volume: player.volume });
    }
    showOverlay();
  }
  function showOverlay() { overlay.className = 'show'; window.clearTimeout(overlayTimer); overlayTimer = window.setTimeout(function () { overlay.className = ''; }, 4000); }
  function clearStallTimer() { if (stallTimer) { window.clearTimeout(stallTimer); stallTimer = null; } }
  player.addEventListener('error', function () { var e = player.error; report(e ? 'Media error ' + e.code + ' (unsupported format, codec, or network failure)' : 'Media playback error'); });
  player.addEventListener('stalled', function () {
    clearStallTimer();
    stallTimer = window.setTimeout(function () { if (!player.paused && player.readyState < 3) report('Playback stalled for over 8 seconds; check the PC and Wi-Fi connection'); }, 8000);
  });
  player.addEventListener('timeupdate', function () {
    if (player.duration && isFinite(player.duration)) { document.getElementById('bar').style.width = Math.min(100, player.currentTime / player.duration * 100) + '%'; document.getElementById('time').innerHTML = Math.floor(player.currentTime) + ' / ' + Math.floor(player.duration) + ' sec'; }
    clearStallTimer();
    if (Date.now() - lastProgressReport > 5000) { lastProgressReport = Date.now(); send('state', { state: 'playing', currentTime: player.currentTime, volume: player.volume }); }
  });
  player.addEventListener('playing', function () { clearStallTimer(); send('state', { state: 'playing', currentTime: player.currentTime, volume: player.volume }); });
  player.addEventListener('pause', function () { send('state', { state: 'paused', currentTime: player.currentTime }); });
  player.addEventListener('click', showOverlay);
  function openSettings() { settings.className = ''; }
  function closeSettings() { settings.className = 'hidden'; }
  document.getElementById('settingsButton').onclick = openSettings;
  document.getElementById('save').onclick = function () { config = { host: host.value.replace(/^https?:\/\//, '').replace(/\/$/, ''), port: port.value || '3000', token: token.value }; localStorage.setItem('homecastConfig', JSON.stringify(config)); closeSettings(); if (socket) socket.close(); connect(); };
  document.getElementById('cancel').onclick = closeSettings;
  document.addEventListener('keydown', function (e) {
    var code = e.keyCode || e.which;
    if (code === 13 && settings.className.indexOf('hidden') >= 0 && idle.className !== 'hidden') openSettings();
    else if (code === 13 && settings.className.indexOf('hidden') >= 0 && idle.className === 'hidden') togglePlayback();
    else if (code === 461 || code === 27) {
      e.preventDefault();
      if (settings.className.indexOf('hidden') < 0) closeSettings();
      else if (lastCast || player.getAttribute('src')) stopPlayback();
    }
    else if (code === 415) player.play(); else if (code === 19) player.pause(); else if (code === 413) control({ action: 'stop' });
    else if (code === 38) control({ action: 'volumeUp' }); else if (code === 40) control({ action: 'volumeDown' });
    else if (code === 412) player.currentTime = Math.max(0, player.currentTime - 10); else if (code === 417) player.currentTime += 10;
    else if (code === 37) player.currentTime = Math.max(0, player.currentTime - 10); else if (code === 39) player.currentTime += 10;
    showOverlay();
  });
  connect();
}());
