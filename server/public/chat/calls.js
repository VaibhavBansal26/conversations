/*!
 * Visitor side of voice and video calls (docs/CALLS.md). Shared by the embeddable widget and the hosted chat: framework-free, builds its own
 * overlay inside the container it is given, talks to the server over the chat's Socket.IO connection (call:* events) and to the agent over WebRTC.
 *
 *   var calls = ConversationsCalls.create({ doc, win, container, getSocket, t, emit, getRoomId, config });
 *   calls.onCallState(payload)   // the visitor copy of `call:state`
 *   calls.request("voice")       // the visitor asks for a call
 *   calls.onSocketConnected()    // after every (re)connect: resumes a running call
 *
 * The visitor is the "polite" peer of the WebRTC negotiation (it rolls back on a collision), the agent the impolite one. No media is recorded or
 * sent anywhere but to the other party (or the TURN relay the server named).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ConversationsCalls = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    call_incoming: "{name} is calling you",
    call_incoming_video: "{name} is calling you (video)",
    call_accept: "Accept",
    call_decline: "Decline",
    call_end: "End call",
    call_mute: "Mute microphone",
    call_unmute: "Unmute microphone",
    call_camera_off: "Turn camera off",
    call_camera_on: "Turn camera on",
    call_share: "Share your screen",
    call_share_stop: "Stop sharing",
    call_connecting: "Connecting...",
    call_ended: "Call ended",
    call_failed: "The call could not connect",
    call_missed: "Call missed",
    call_quality_good: "Connection: good",
    call_quality_fair: "Connection: fair",
    call_quality_poor: "Connection: poor",
    call_mic_blocked: "Microphone access was blocked, so the call was declined.",
    call_audio_only: "Camera not available: continuing with audio only.",
    call_devices: "Audio and video devices",
    call_microphone: "Microphone",
    call_camera: "Camera",
    call_speaker: "Speaker",
    call_request_voice: "Request a voice call",
    call_request_video: "Request a video call",
    call_requested: "Request sent. A team member will call you.",
    call_remote_video: "Video of the other person",
    call_local_video: "Your video",
    call_reconnecting: "Reconnecting...",
  };

  /** CSS for the overlay, using the host's custom properties (--c brand, --t text on brand, --bg, --fg, --line, --r). The widget injects it into its shadow root. */
  var CSS = [
    ".call{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;background:#10131a;color:#fff;font-family:inherit}",
    ".call[hidden]{display:none}",
    ".call .stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#0b0d12;overflow:hidden}",
    ".call video.remote{width:100%;height:100%;object-fit:contain;background:#0b0d12}",
    ".call video.local{position:absolute;right:12px;bottom:12px;width:28%;max-width:140px;aspect-ratio:3/4;object-fit:cover;border-radius:10px;border:2px solid rgba(255,255,255,.6);background:#222;transform:scaleX(-1)}",
    ".call video.local[hidden]{display:none}",
    ".call .who{position:absolute;top:14px;left:0;right:0;text-align:center;font-size:15px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,.6)}",
    ".call .sub{display:block;font-size:12.5px;font-weight:400;opacity:.9;margin-top:2px}",
    ".call .q{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#9aa0aa;vertical-align:0}.call .q.good{background:#4ade80}.call .q.fair{background:#facc15}.call .q.poor{background:#f87171}",
    ".call .note{position:absolute;bottom:60px;left:12px;right:12px;text-align:center;font-size:13px;background:rgba(0,0,0,.55);border-radius:8px;padding:6px 10px}.call .note:empty{display:none}",
    ".call .bar{display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap;padding:12px;background:#10131a}",
    ".call .bar button{min-width:48px;height:48px;border-radius:50%;border:0;background:#2a2f3a;color:#fff;cursor:pointer;font-size:13px;font-weight:600;padding:0 12px}",
    ".call .bar button:hover,.call .bar button:focus-visible{background:#3a4150;outline:2px solid #fff;outline-offset:2px}",
    ".call .bar button[aria-pressed=true]{background:#fff;color:#10131a}",
    ".call .bar .end{background:#d92d20}.call .bar .end:hover{background:#b42318}",
    ".call .bar .accept{background:#16a34a}.call .bar .accept:hover{background:#15803d}",
    ".call .bar .decline{background:#d92d20}",
    ".call .dev{padding:0 12px 12px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;background:#10131a}.call .dev[hidden]{display:none}",
    ".call .dev label{font-size:12px;display:flex;flex-direction:column;gap:3px}.call .dev select{max-width:160px;background:#2a2f3a;color:#fff;border:1px solid #444b59;border-radius:6px;padding:4px}",
    ".call .timer{font-variant-numeric:tabular-nums}",
    ".callreq{display:flex;gap:6px;justify-content:center;padding:2px 8px}.callreq[hidden]{display:none}.callreq button{border:0;background:transparent;color:var(--muted,#555);text-decoration:underline;cursor:pointer;font-size:12.5px;padding:3px 6px}",
  ].join("\n");

  function create(o) {
    var doc = o.doc, win = o.win || (doc && doc.defaultView);
    var strings = o.t || function (k, vars) { return fmt(DEFAULTS[k] || k, vars); };
    function t(k, vars) {
      var s = strings(k, vars);
      // a host dictionary without our keys returns the key itself: fall back to the English text
      return s === k && DEFAULTS[k] ? fmt(DEFAULTS[k], vars) : s;
    }
    var emit = o.emit || function () {};
    var rtcCtor = o.RTCPeerConnection || (win && win.RTCPeerConnection);
    var media = o.mediaDevices || (win && win.navigator && win.navigator.mediaDevices);
    var cfg = o.config || { browser: { enabled: false, voice: true, video: true } };
    var S = { call: null, pc: null, local: null, screen: null, remoteStream: null, polite: true, makingOffer: false, ignoreOffer: false, pendingIce: [], connected: false, since: 0, timer: null, stats: null, muted: false, camOff: false, sharing: false, ice: [], failTimer: null, el: null };

    function fmt(s, vars) { return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] !== undefined ? String(vars[k]) : m; }) : s; }
    function h(tag, attrs, kids) {
      var el = doc.createElement(tag);
      if (attrs) for (var k in attrs) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
        else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : v);
      }
      (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
      return el;
    }
    function socket() { return o.getSocket && o.getSocket(); }
    function send(event, payload) {
      return new Promise(function (resolve) {
        var s = socket();
        if (!s) return resolve({ ok: false, error: { code: "OFFLINE", message: "offline" } });
        var done = false, timer = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, error: { code: "TIMEOUT", message: "timeout" } }); } }, 8000);
        s.emit(event, payload, function (ack) { if (done) return; done = true; clearTimeout(timer); resolve(ack || { ok: false }); });
      });
    }

    /* ---------- overlay ---------- */
    function build() {
      if (S.el) return S.el;
      var remote = h("video", { class: "remote", autoplay: true, playsinline: true, "aria-label": t("call_remote_video") });
      var local = h("video", { class: "local", autoplay: true, playsinline: true, muted: true, hidden: true, "aria-label": t("call_local_video") });
      local.muted = true;
      var who = h("div", { class: "who", "aria-live": "polite" });
      var note = h("div", { class: "note", role: "status" });
      var stage = h("div", { class: "stage" }, [remote, local, who, note]);
      var bar = h("div", { class: "bar" });
      var dev = h("div", { class: "dev", hidden: true });
      var el = h("section", { class: "call", role: "dialog", "aria-modal": "true", "aria-label": "Call", hidden: true }, [stage, dev, bar]);
      el.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.call && S.call.state !== "ringing") end(); });
      S.el = { root: el, remote: remote, local: local, who: who, note: note, bar: bar, dev: dev };
      o.container.appendChild(el);
      return S.el;
    }
    function button(cls, label, text, onclick, pressed) {
      return h("button", { type: "button", class: cls, "aria-label": label, "aria-pressed": pressed === undefined ? null : String(pressed), text: text, onclick: onclick });
    }
    function setWho(name, sub, quality) {
      var u = S.el.who;
      u.textContent = "";
      u.appendChild(doc.createTextNode(name));
      var s = h("span", { class: "sub" });
      if (quality) s.appendChild(h("span", { class: "q " + quality, role: "img", "aria-label": t("call_quality_" + quality) }));
      s.appendChild(doc.createTextNode(sub || ""));
      u.appendChild(s);
    }
    function showRinging(call) {
      var u = build();
      u.root.hidden = false;
      u.bar.textContent = "";
      u.dev.hidden = true;
      u.local.hidden = true;
      setWho(call.agent_name || "", t(call.kind === "video" ? "call_incoming_video" : "call_incoming", { name: call.agent_name || "" }));
      u.note.textContent = "";
      u.bar.appendChild(button("accept", t("call_accept"), t("call_accept"), function () { accept(); }));
      u.bar.appendChild(button("decline", t("call_decline"), t("call_decline"), function () { decline(); }));
      var acc = u.bar.querySelector(".accept");
      if (acc && acc.focus) acc.focus();
      ring(true);
      if (o.onRinging) o.onRinging(call);
    }
    function showActive() {
      var u = build();
      u.root.hidden = false;
      u.bar.textContent = "";
      var video = S.call && S.call.kind === "video";
      u.bar.appendChild(button("mute", t(S.muted ? "call_unmute" : "call_mute"), S.muted ? "Mic off" : "Mic", function () { toggleMute(); }, S.muted));
      if (video && hasVideoTrack()) u.bar.appendChild(button("cam", t(S.camOff ? "call_camera_on" : "call_camera_off"), S.camOff ? "Cam off" : "Cam", function () { toggleCamera(); }, S.camOff));
      if (cfg.browser && cfg.browser.screen_share !== false && media && media.getDisplayMedia && video) u.bar.appendChild(button("share", t(S.sharing ? "call_share_stop" : "call_share"), S.sharing ? "Stop sharing" : "Share screen", function () { toggleShare(); }, S.sharing));
      if (media && media.enumerateDevices) u.bar.appendChild(button("devices", t("call_devices"), "Devices", function () { toggleDevices(); }));
      u.bar.appendChild(button("end", t("call_end"), t("call_end"), function () { end(); }));
      u.local.hidden = !(video && hasVideoTrack());
      renderHeader();
    }
    function hasVideoTrack() { return !!(S.local && S.local.getVideoTracks().length); }
    function renderHeader(quality) {
      if (!S.el || !S.call) return;
      var sub = S.connected ? fmtTime(Math.max(0, Math.floor((Date.now() - S.since) / 1000))) : t("call_connecting");
      setWho(S.call.agent_name || "", sub, quality || S.quality);
      var timer = S.el.who.querySelector(".sub");
      if (timer && S.connected) timer.className = "sub timer";
    }
    function fmtTime(s) { var m = Math.floor(s / 60); return (m < 10 ? "0" : "") + m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60); }
    function say(text) { if (S.el) S.el.note.textContent = text || ""; }

    var ringCtx = null, ringTimer = null;
    function ring(on) {
      clearInterval(ringTimer);
      ringTimer = null;
      if (!on || !win) return;
      var Ctx = win.AudioContext || win.webkitAudioContext;
      if (!Ctx) return;
      var beep = function () {
        try {
          ringCtx = ringCtx || new Ctx();
          var osc = ringCtx.createOscillator(), g = ringCtx.createGain();
          osc.connect(g); g.connect(ringCtx.destination); g.gain.value = 0.05; osc.frequency.value = 660; osc.start(); osc.stop(ringCtx.currentTime + 0.25);
        } catch (e) { /* a browser may refuse sound before a tap: the overlay is the signal */ }
      };
      beep();
      ringTimer = setInterval(beep, 2000);
    }

    /* ---------- actions ---------- */
    function getMedia(kind) {
      if (!media || !media.getUserMedia) return Promise.reject(new Error("no media devices"));
      return media.getUserMedia({ audio: true, video: kind === "video" }).catch(function (e) {
        if (kind !== "video") throw e;
        // no camera, or camera denied: audio only, and say so
        return media.getUserMedia({ audio: true }).then(function (s) { S.audioOnly = true; return s; });
      });
    }

    function accept() {
      var call = S.call;
      if (!call || S.accepting) return;
      S.accepting = true;
      ring(false);
      var gotMedia = false;
      getMedia(call.kind).then(function (stream) {
        gotMedia = true;
        S.local = stream;
        return send("call:accept", { call_id: call.id }).then(function (ack) {
          if (!ack.ok) { stopLocal(); throw new Error(ack.error && ack.error.message); }
          S.ice = (ack.ice && ack.ice.iceServers) || [];
          S.call = Object.assign({}, call, ack.call);
          setupPeer();
          showActive();
          if (S.audioOnly) say(t("call_audio_only"));
          S.local && attachLocal();
        });
      }).catch(function (e) {
        S.accepting = false;
        // refused or unavailable microphone: decline so the agent is not left waiting, and tell the visitor why
        if (!gotMedia) { send("call:decline", { call_id: call.id }); showEnded(t("call_mic_blocked")); }
        else showEnded(t("call_failed"));
      });
    }
    function decline() {
      ring(false);
      var call = S.call;
      if (call) send("call:decline", { call_id: call.id });
      teardown();
    }
    function end() {
      var call = S.call;
      if (call) send("call:end", { call_id: call.id });
      showEnded(t("call_ended"));
    }

    function attachLocal() {
      if (!S.el) return;
      S.el.local.srcObject = S.local;
      S.el.local.hidden = !(S.call && S.call.kind === "video" && hasVideoTrack());
    }

    /* ---------- WebRTC (perfect negotiation; the visitor is the polite peer) ---------- */
    function setupPeer() {
      if (!rtcCtor) { showEnded(t("call_failed")); send("call:failed", { call_id: S.call.id, reason: "no_webrtc" }); return; }
      var pc = new rtcCtor({ iceServers: S.ice });
      S.pc = pc;
      S.remoteStream = null;
      pc.onicecandidate = function (e) {
        if (!S.call) return;
        send("call:ice", { call_id: S.call.id, data: e.candidate ? (e.candidate.toJSON ? e.candidate.toJSON() : { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }) : {} });
      };
      pc.ontrack = function (e) {
        if (!S.el) return;
        S.remoteStream = (e.streams && e.streams[0]) || S.remoteStream || new win.MediaStream();
        if (!(e.streams && e.streams[0]) && S.remoteStream.addTrack) S.remoteStream.addTrack(e.track);
        S.el.remote.srcObject = S.remoteStream;
        var p = S.el.remote.play && S.el.remote.play();
        if (p && p.catch) p.catch(function () {});
      };
      pc.onnegotiationneeded = function () {
        // only a renegotiation (screen share, a restart) starts here: the first offer comes from the agent
        if (!S.call || !pc.remoteDescription) return;
        S.makingOffer = true;
        Promise.resolve(pc.setLocalDescription()).then(function () { return send("call:offer", { call_id: S.call.id, data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); }).catch(function () {}).then(function () { S.makingOffer = false; });
      };
      pc.onconnectionstatechange = function () {
        var st = pc.connectionState;
        if (st === "connected") {
          clearTimeout(S.failTimer);
          if (!S.connected) { S.connected = true; S.since = Date.now(); send("call:connected", { call_id: S.call.id }); startStats(); startTimer(); }
          say("");
          showActive();
        } else if (st === "disconnected" || st === "failed") {
          say(t("call_reconnecting"));
          clearTimeout(S.failTimer);
          // the agent restarts ICE when it sees the drop; if nothing helps within 15 s the call is reported failed
          S.failTimer = setTimeout(function () { if (S.call && S.pc && (S.pc.connectionState === "failed" || S.pc.connectionState === "disconnected")) { send("call:failed", { call_id: S.call.id, reason: "ice_failed" }); } }, 15000);
        }
      };
    }
    function addLocalTracks() {
      if (!S.local || !S.pc) return;
      var senders = S.pc.getSenders ? S.pc.getSenders() : [];
      S.local.getTracks().forEach(function (track) {
        // reuse the transceiver the offer created for this kind (so the answer is sendrecv without a second negotiation)
        var tr = (S.pc.getTransceivers ? S.pc.getTransceivers() : []).filter(function (x) { return x.receiver && x.receiver.track && x.receiver.track.kind === track.kind && !(x.sender && x.sender.track); })[0];
        if (tr) { tr.sender.replaceTrack(track); try { tr.direction = "sendrecv"; } catch (e) { /* ignore */ } }
        else if (!senders.some(function (s) { return s.track === track; })) S.pc.addTrack(track, S.local);
      });
    }

    function onOffer(p) {
      var pc = S.pc;
      if (!pc || !S.call || p.call_id !== S.call.id) return;
      var desc = p.data;
      var collision = desc.type === "offer" && (S.makingOffer || pc.signalingState !== "stable");
      S.ignoreOffer = !S.polite && collision;
      if (S.ignoreOffer) return;
      Promise.resolve()
        .then(function () { return collision ? pc.setLocalDescription({ type: "rollback" }) : null; })
        .then(function () { return pc.setRemoteDescription({ type: desc.type, sdp: desc.sdp }); })
        .then(function () {
          if (!S.firstOfferHandled) { S.firstOfferHandled = true; addLocalTracks(); }
          var queued = S.pendingIce.splice(0);
          return Promise.all(queued.map(function (c) { return pc.addIceCandidate(c).catch(function () {}); }));
        })
        .then(function () { return pc.setLocalDescription(); })
        .then(function () { return send("call:answer", { call_id: S.call.id, data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }); })
        .catch(function () { /* a failed negotiation shows up as a failed connection */ });
    }
    function onAnswer(p) {
      if (!S.pc || !S.call || p.call_id !== S.call.id) return;
      S.pc.setRemoteDescription({ type: p.data.type, sdp: p.data.sdp }).catch(function () {});
    }
    function onIce(p) {
      if (!S.pc || !S.call || p.call_id !== S.call.id) return;
      var c = p.data && p.data.candidate ? p.data : null;
      if (!c) return; // end of candidates
      if (!S.pc.remoteDescription) { S.pendingIce.push(c); return; }
      S.pc.addIceCandidate(c).catch(function () { /* a candidate for a description we rolled back */ });
    }

    /* ---------- controls ---------- */
    function toggleMute() {
      S.muted = !S.muted;
      if (S.local) S.local.getAudioTracks().forEach(function (tr) { tr.enabled = !S.muted; });
      showActive();
    }
    function toggleCamera() {
      S.camOff = !S.camOff;
      if (S.local) S.local.getVideoTracks().forEach(function (tr) { tr.enabled = !S.camOff; });
      showActive();
    }
    function toggleShare() {
      if (S.sharing) return stopShare();
      media.getDisplayMedia({ video: true }).then(function (stream) {
        S.screen = stream;
        var track = stream.getVideoTracks()[0];
        var sender = S.pc && S.pc.getSenders().filter(function (s) { return s.track && s.track.kind === "video"; })[0];
        if (sender) sender.replaceTrack(track); else if (S.pc) S.pc.addTrack(track, stream);
        track.onended = stopShare;
        S.sharing = true;
        showActive();
      }).catch(function () { /* the visitor cancelled the picker */ });
    }
    function stopShare() {
      if (!S.sharing) return;
      var cam = S.local && S.local.getVideoTracks()[0];
      var sender = S.pc && S.pc.getSenders().filter(function (s) { return s.track && s.track.kind === "video"; })[0];
      if (sender) sender.replaceTrack(cam || null);
      if (S.screen) S.screen.getTracks().forEach(function (tr) { tr.stop(); });
      S.screen = null;
      S.sharing = false;
      showActive();
    }
    function toggleDevices() {
      var d = S.el.dev;
      if (!d.hidden) { d.hidden = true; return; }
      media.enumerateDevices().then(function (list) {
        d.textContent = "";
        var kinds = [["audioinput", "call_microphone"], ["videoinput", "call_camera"], ["audiooutput", "call_speaker"]];
        kinds.forEach(function (k) {
          var items = list.filter(function (x) { return x.kind === k[0]; });
          if (!items.length || (k[0] === "videoinput" && !hasVideoTrack()) || (k[0] === "audiooutput" && !(S.el.remote.setSinkId))) return;
          var sel = h("select", null, items.map(function (x, i) { return h("option", { value: x.deviceId, text: x.label || (t(k[1]) + " " + (i + 1)) }); }));
          sel.addEventListener("change", function () { pickDevice(k[0], sel.value); });
          d.appendChild(h("label", null, [t(k[1]), sel]));
        });
        d.hidden = false;
      }).catch(function () {});
    }
    function pickDevice(kind, id) {
      if (kind === "audiooutput") return void (S.el.remote.setSinkId && S.el.remote.setSinkId(id).catch(function () {}));
      var constraints = kind === "audioinput" ? { audio: { deviceId: { exact: id } } } : { video: { deviceId: { exact: id } } };
      media.getUserMedia(constraints).then(function (s) {
        var track = s.getTracks()[0];
        var old = S.local.getTracks().filter(function (x) { return x.kind === track.kind; })[0];
        var sender = S.pc.getSenders().filter(function (x) { return x.track && x.track.kind === track.kind; })[0];
        if (sender) sender.replaceTrack(track);
        if (old) { S.local.removeTrack(old); old.stop(); }
        S.local.addTrack(track);
        track.enabled = kind === "audioinput" ? !S.muted : !S.camOff;
        attachLocal();
      }).catch(function () {});
    }

    /* ---------- quality and timer ---------- */
    function startStats() {
      clearInterval(S.stats);
      var prev = null;
      S.stats = setInterval(function () {
        if (!S.pc || !S.pc.getStats) return;
        S.pc.getStats().then(function (report) {
          var lost = 0, recv = 0, rtt = null;
          report.forEach(function (r) {
            if (r.type === "inbound-rtp") { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; }
            if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded") && typeof r.currentRoundTripTime === "number") rtt = r.currentRoundTripTime;
          });
          var dLost = prev ? lost - prev.lost : lost, dRecv = prev ? recv - prev.recv : recv;
          prev = { lost: lost, recv: recv };
          var loss = dLost + dRecv > 0 ? dLost / (dLost + dRecv) : 0;
          S.quality = loss > 0.08 || (rtt !== null && rtt > 0.6) ? "poor" : loss > 0.03 || (rtt !== null && rtt > 0.3) ? "fair" : "good";
          renderHeader(S.quality);
        }).catch(function () {});
      }, 2000);
    }
    function startTimer() {
      clearInterval(S.timer);
      S.timer = setInterval(function () { renderHeader(); }, 1000);
    }

    /* ---------- lifecycle ---------- */
    function stopLocal() {
      [S.local, S.screen].forEach(function (s) { if (s) s.getTracks().forEach(function (tr) { tr.stop(); }); });
      S.local = null; S.screen = null;
    }
    function teardown() {
      ring(false);
      clearInterval(S.timer); clearInterval(S.stats); clearTimeout(S.failTimer);
      if (S.pc) { try { S.pc.close(); } catch (e) { /* ignore */ } }
      stopLocal();
      var el = S.el;
      S = { call: null, pc: null, local: null, screen: null, remoteStream: null, polite: true, makingOffer: false, ignoreOffer: false, pendingIce: [], connected: false, since: 0, timer: null, stats: null, muted: false, camOff: false, sharing: false, ice: [], failTimer: null, el: el };
      if (el) { el.root.hidden = true; el.remote.srcObject = null; el.local.srcObject = null; el.bar.textContent = ""; el.note.textContent = ""; el.dev.hidden = true; }
    }
    function showEnded(text) {
      var u = build();
      var last = S.call;
      ring(false);
      clearInterval(S.timer); clearInterval(S.stats); clearTimeout(S.failTimer);
      if (S.pc) { try { S.pc.close(); } catch (e) { /* ignore */ } S.pc = null; }
      stopLocal();
      u.root.hidden = false;
      u.local.hidden = true;
      u.bar.textContent = "";
      u.dev.hidden = true;
      setWho(last && last.agent_name || "", text);
      u.note.textContent = "";
      var close = button("end", t("call_end"), "OK", function () { teardown(); });
      u.bar.appendChild(close);
      var btn = u.bar.querySelector("button");
      if (btn && btn.focus) btn.focus();
      // a final message stays long enough to read, then the overlay goes away on its own
      setTimeout(function () { if (S.call === last || !S.call) { if (!S.pc) teardown(); } }, 4000);
    }

    /** The visitor copy of `call:state`. */
    function onCallState(p) {
      var call = p && p.call;
      if (!call || (o.getRoomId && call.room_id !== o.getRoomId())) return;
      emit("call_state", { room_id: call.room_id, call_id: call.id, state: call.state, kind: call.kind });
      // a phone call rings the visitor's phone, not this page: the thread card is the only thing to show
      if (call.transport === "phone") return;
      if (S.call && S.call.id !== call.id) return; // a state of some other call
      if (call.state === "ringing" && !S.call) {
        S.call = call;
        showRinging(call);
      } else if (S.call) {
        S.call = Object.assign({}, S.call, call);
        if (call.state === "ended") showEnded(t("call_ended"));
        else if (call.state === "missed" || call.state === "declined") teardown();
        else if (call.state === "failed") showEnded(t("call_failed"));
      }
    }

    /** After a reconnect of the chat socket: if a call is running, bind this socket to it and let the agent restart ICE. */
    function onSocketConnected() {
      var call = S.call;
      if (!call || call.state === "ringing" || !S.pc) return;
      send("call:resume", { call_id: call.id }).then(function (ack) {
        if (!ack.ok) return showEnded(t("call_ended"));
        S.ice = (ack.ice && ack.ice.iceServers) || S.ice;
        if (S.pc.setConfiguration) try { S.pc.setConfiguration({ iceServers: S.ice }); } catch (e) { /* ignore */ }
      });
    }

    function request(kind) {
      return send("call:request", { room_id: o.getRoomId(), kind: kind }).then(function (ack) {
        if (ack.ok) emit("call_requested", { room_id: o.getRoomId(), kind: kind });
        return ack;
      });
    }

    function handleSignal(type) {
      return function (p) { return type === "offer" ? onOffer(p) : type === "answer" ? onAnswer(p) : onIce(p); };
    }
    /** Wire the signalling events of a (new) socket. */
    function bind(s) {
      s.on("call:state", onCallState);
      s.on("call:offer", handleSignal("offer"));
      s.on("call:answer", handleSignal("answer"));
      s.on("call:ice", handleSignal("ice"));
      s.on("call:peer", function (p) { if (S.call && p.call_id === S.call.id) say(p.event === "lost" ? t("call_reconnecting") : ""); });
      s.on("connect", onSocketConnected);
    }

    /** Request buttons under the message list ("Request a voice call"): the caller places the returned element where it fits. */
    function requestBar() {
      var voice = cfg.browser && cfg.browser.enabled && cfg.browser.voice !== false;
      var video = cfg.browser && cfg.browser.enabled && cfg.browser.video !== false;
      if (!voice && !video) return null;
      var bar = h("div", { class: "callreq" });
      var note = h("span", { role: "status" });
      function go(kind) { request(kind).then(function (ack) { note.textContent = ack.ok ? t("call_requested") : ""; }); }
      if (voice) bar.appendChild(h("button", { type: "button", "data-call-request": "voice", text: t("call_request_voice"), onclick: function () { go("voice"); } }));
      if (video) bar.appendChild(h("button", { type: "button", "data-call-request": "video", text: t("call_request_video"), onclick: function () { go("video"); } }));
      bar.appendChild(note);
      return bar;
    }

    return { bind: bind, onCallState: onCallState, onSocketConnected: onSocketConnected, request: request, requestBar: requestBar, destroy: function () { teardown(); if (S.el && S.el.root.parentNode) S.el.root.parentNode.removeChild(S.el.root); S.el = null; }, state: function () { return S.call; }, _S: S };
  }

  return { create: create, css: CSS, DEFAULTS: DEFAULTS };
});
