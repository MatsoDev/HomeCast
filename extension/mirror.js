'use strict';
(function () {
  var stateNode = document.getElementById('state'), messageNode = document.getElementById('message');
  var launch = null, media = null, recorder = null, socket = null, audioContext = null, audioSource = null, stopped = false;
  function show(state, message) { stateNode.textContent = state; if (message) messageNode.textContent = message; }
  function report(state, error) {
    if (!launch) return;
    chrome.runtime.sendMessage({ type: 'homecast-mirror-update', status: { state: state, error: error || '', sessionId: launch.sessionId, server: launch.server, token: launch.token } });
  }
  function stop(reason, tellServer) {
    if (stopped) return; stopped = true;
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (ignore) {} }
    if (media) media.getTracks().forEach(function (track) { try { track.stop(); } catch (ignore) {} });
    if (audioSource) { try { audioSource.disconnect(); } catch (ignore) {} }
    if (audioContext) { try { audioContext.close(); } catch (ignore) {} }
    if (socket) { try { socket.close(); } catch (ignore) {} }
    show('Stopped', reason || 'Mirror stopped.'); report('stopped', reason || '');
    if (tellServer && launch) fetch(launch.server + '/mirror/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pairing-Token': launch.token }, body: JSON.stringify({ sessionId: launch.sessionId, reason: reason || 'Stopped by user' }) }).catch(function () {});
  }
  function onCapture(stream) {
    media = stream;
    var audioTracks = stream.getAudioTracks();
    if (audioTracks.length && window.AudioContext) {
      try { audioContext = new AudioContext(); audioSource = audioContext.createMediaStreamSource(new MediaStream(audioTracks)); audioSource.connect(audioContext.destination); } catch (ignore) {}
    }
    show('Connecting', audioTracks.length ? 'Video and tab audio captured. Connecting to the PC encoder…' : 'Video captured, but Chrome gave no audio track. Stop and select the tab again with Share audio enabled.'); report('captured');
    var mime = '';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) mime = 'video/webm;codecs=vp8,opus';
    else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) mime = 'video/webm;codecs=vp8';
    else if (MediaRecorder.isTypeSupported('video/webm')) mime = 'video/webm';
    var url = new URL(launch.server); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = '/mirror/ws'; url.search = '';
    url.searchParams.set('session', launch.sessionId); url.searchParams.set('token', launch.token || '');
    socket = new WebSocket(url.href); socket.binaryType = 'arraybuffer';
    socket.onopen = function () { socket.send(JSON.stringify({ type: 'start', mime: mime })); };
    socket.onmessage = function (event) {
      var reply; try { reply = JSON.parse(event.data); } catch (ignore) { return; }
      if (reply.type === 'ready') {
        try { recorder = new MediaRecorder(media, { mimeType: mime || undefined, videoBitsPerSecond: 3500000, audioBitsPerSecond: 128000 }); }
        catch (error) { show('Error', error.message); report('error', error.message); return; }
        recorder.ondataavailable = function (e) { if (e.data && e.data.size && socket && socket.readyState === WebSocket.OPEN) { if (socket.bufferedAmount > 8 * 1024 * 1024) return stop('PC encoder is falling behind; lower source resolution.', true); socket.send(e.data); } };
        recorder.onerror = function (e) { var error = e.error ? e.error.message : 'Tab recording failed'; show('Error', error); report('error', error); };
        recorder.start(1000); show('Mirroring', audioTracks.length ? 'Sending video and audio to the TV.' : 'Sending video only. Enable Share audio in Chrome’s picker to include sound.'); report('capturing');
      } else if (reply.type === 'error') { show('Error', reply.message); report('error', reply.message); }
    };
    socket.onerror = function () { var error = 'Mirror connection to the PC server failed.'; show('Error', error); report('error', error); };
    socket.onclose = function () { if (!stopped && recorder) stop('Mirror connection closed.', false); };
  }
  function choose() {
    show('Choose tab', 'Select the playing browser tab in Chrome’s picker. Turn on Share audio if needed.');
    try {
      chrome.desktopCapture.chooseDesktopMedia(['tab', 'audio'], function (streamId, options) {
        if (!streamId) { show('Cancelled', 'No tab was selected. You can close this window.'); report('error', 'Tab selection was cancelled.'); return; }
        show('Capturing', 'Chrome selected the tab. Starting video capture…');
        var constraints = { video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId, maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 } } };
        if (options && options.canRequestAudioTrack) constraints.audio = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } };
        navigator.mediaDevices.getUserMedia(constraints).then(onCapture).catch(function (error) {
          var detail = (error.name || 'CaptureError') + ': ' + (error.message || 'Chrome could not capture the selected tab');
          show('Capture failed', detail); report('error', detail);
        });
      });
    } catch (error) { show('Capture failed', error.message || String(error)); report('error', error.message || String(error)); }
  }
  document.getElementById('stop').addEventListener('click', function () { stop('Stopped by user.', true); });
  window.addEventListener('beforeunload', function () { if (!stopped) stop('Mirror window closed.', true); });
  chrome.storage.local.get('mirrorLaunch', function (data) {
    launch = data.mirrorLaunch;
    if (!launch || !launch.sessionId || !launch.server) return show('No session', 'Start Mirror from the HomeCast extension popup.');
    choose();
  });
}());
