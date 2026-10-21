/*!
 * Visitor side of calls with the AI assistant (docs/CALLS.md, ADR 0033). Shared by the embeddable widget and the hosted chat; framework-free.
 *
 * The visitor's BROWSER does the speech: SpeechRecognition turns what is said into text, speechSynthesis speaks the reply. The server only ever receives
 * and returns text (socket events aicall:start, aicall:say, aicall:end, aicall:handoff), so the answer comes from the same pipeline as a typed message
 * (knowledge base, safety guards, hand-off triggers, budget). No audio is sent to this app, nothing is recorded, and a "video" call with the AI is an
 * animated avatar: the visitor's camera is never sent anywhere (an optional self-view stays in the page).
 *
 *   var ai = ConversationsAiCall.create({ doc, win, container, getSocket, t, emit, getRoomId, config, onFallback });
 *   ai.bind(socket)        // call:state (to notice the end of the call and a person ringing) and reconnects
 *   ai.start("voice")      // or "video" (the avatar)
 *   ai.bar()               // the buttons to put under the message list (null when the workspace has AI calls off)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ConversationsAiCall = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULTS = {
    aicall_voice: "Talk to our AI assistant (voice)",
    aicall_video: "Video call with our AI assistant (avatar)",
    aicall_title: "Call with {name}",
    aicall_badge: "{label}, not a person",
    aicall_starting: "Starting the call...",
    aicall_listening: "Listening...",
    aicall_thinking: "Thinking...",
    aicall_speaking: "Speaking... (talk to interrupt)",
    aicall_muted: "Microphone muted",
    aicall_ptt_hold: "Hold to talk",
    aicall_ptt_use: "Use push-to-talk",
    aicall_ptt_off: "Always listening",
    aicall_mute: "Mute microphone",
    aicall_unmute: "Unmute microphone",
    aicall_type_label: "Type instead of speaking",
    aicall_type_send: "Send",
    aicall_you: "You",
    aicall_captions: "Captions",
    aicall_person: "Talk to a person",
    aicall_end: "End call",
    aicall_unsupported: "Your browser cannot recognise speech (Firefox cannot, for example), so voice calls are not available here. You can chat with our AI assistant in writing instead.",
    aicall_mic_blocked: "Microphone access was blocked. You can type to the assistant instead, or allow the microphone in your browser settings.",
    aicall_still_there: "Are you still there?",
    aicall_silence_end: "I did not hear anything, so I ended the call. You can start again at any time.",
    aicall_ended: "Call ended",
    aicall_resolved: "Glad I could help. Goodbye!",
    aicall_time_limit: "We reached the time limit for a call with me. A person can continue by chat or call.",
    aicall_taken_over: "A person has joined this conversation.",
    aicall_waiting_person: "I'm connecting you with a person. Keep this window open: they will call you here.",
    aicall_waiting_chat: "I'm connecting you with a person. They will answer in the chat.",
    aicall_error: "Something went wrong with the call. You can try again, or write to us.",
    aicall_busy: "The assistant is busy with other calls. Please try again in a minute, or write to us.",
    aicall_limit: "Please slow down a little.",
    aicall_unavailable: "The assistant is not available for calls right now. You can write to us instead.",
    aicall_privacy: "Your browser recognises your speech. This call is not recorded.",
    aicall_level: "Microphone level",
    aicall_camera_show: "Show my camera",
    aicall_camera_hide: "Hide my camera",
    aicall_self_view: "Your camera (only you see this)",
    aicall_video_note: "Video call with an AI avatar. The assistant cannot see you, and your camera is not sent anywhere.",
    aicall_avatar: "{name}, animated AI avatar",
    aicall_close: "Close",
    aicall_realtime_note: "Live voice: the assistant's voice and your speech go to a voice service over an encrypted connection (not recorded by us).",
    aicall_switched: "The live voice connection failed, so I switched to your browser's voice.",
    aicall_monitor: "I'm connecting you with a person.",
  };

  /** CSS for the overlay (the widget injects it into its shadow root; the hosted chat links chat.css and adds this). Dark like the call screen. */
  var CSS = [
    ".aicall{position:absolute;inset:0;z-index:31;display:flex;flex-direction:column;background:#10131a;color:#fff;font-family:inherit}",
    ".aicall[hidden]{display:none}",
    ".aicall .ai-head{padding:12px 14px 6px;text-align:center}",
    ".aicall .ai-name{font-size:16px;font-weight:600}",
    ".aicall .ai-badge{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;background:#2a2f3a;font-size:12px;font-weight:600;color:#cfd5df}",
    ".aicall .ai-sub{display:block;font-size:12.5px;opacity:.85;margin-top:3px;font-variant-numeric:tabular-nums}",
    ".aicall .ai-stage{position:relative;display:flex;align-items:center;justify-content:center;min-height:132px;padding:10px 0 6px;flex:0 0 auto}",
    ".aicall .face{position:relative;width:104px;height:104px;--lvl:0;--c:#6b7280}",
    ".aicall[data-kind=video] .face{width:176px;height:176px}",
    ".aicall .face[data-state=listening]{--c:#4ade80}.aicall .face[data-state=thinking]{--c:#facc15}.aicall .face[data-state=speaking]{--c:#60a5fa}",
    ".aicall .face-ring{position:absolute;inset:-9px;border-radius:50%;border:3px solid var(--c);opacity:.9;transform:scale(calc(1 + var(--lvl)*.09));box-shadow:0 0 calc(6px + var(--lvl)*26px) var(--c);transition:border-color .2s,box-shadow .1s}",
    ".aicall .face[data-state=idle] .face-ring{opacity:.35;box-shadow:none}",
    ".aicall .face-frame{position:absolute;inset:0;border-radius:50%;overflow:hidden;background:#2a2f3a;display:flex;align-items:center;justify-content:center;transform:scale(calc(1 + var(--lvl)*.025))}",
    ".aicall .face-photo{width:100%;height:100%;object-fit:cover;display:block;transform:translate(var(--px,0),var(--py,0)) scale(1.04)}",
    ".aicall .face-svg{width:100%;height:100%;transform:rotate(var(--tilt,0deg))}",
    ".aicall .face-svg .eye{transform-box:fill-box;transform-origin:center;transition:transform .07s}.aicall .face.blink .face-svg .eye{transform:scaleY(.1)}",
    ".aicall .face-svg .mouth{transform-box:fill-box;transform-origin:center;transform:scaleY(var(--mouth,.15))}",
    ".aicall .face[data-state=thinking] .face-svg .eye{transform:translateY(-3px)}",
    ".aicall .face-wave{position:absolute;left:50%;bottom:-16px;transform:translateX(-50%);display:flex;gap:3px;align-items:flex-end;height:16px;opacity:0;transition:opacity .15s}",
    ".aicall .face[data-state=speaking] .face-wave{opacity:1}",
    ".aicall .face-wave i{display:block;width:4px;height:16px;border-radius:2px;background:var(--c);transform-origin:50% 100%;transform:scaleY(var(--b,.25))}",
    ".aicall .face-dots{position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);display:flex;gap:5px;opacity:0;transition:opacity .15s}",
    ".aicall .face[data-state=thinking] .face-dots{opacity:1}",
    ".aicall .face-dots i{width:6px;height:6px;border-radius:50%;background:var(--c);animation:aidot 1s infinite ease-in-out}.aicall .face-dots i:nth-child(2){animation-delay:.15s}.aicall .face-dots i:nth-child(3){animation-delay:.3s}",
    "@keyframes aidot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}",
    ".aicall .face-label{position:absolute;left:50%;top:-12px;transform:translateX(-50%);white-space:nowrap;padding:2px 9px;border-radius:999px;background:#0b0d12;border:1px solid #4b5568;color:#e5e9f0;font-size:11.5px;font-weight:700;letter-spacing:.02em}",
    ".aicall .ai-self{position:absolute;right:10px;bottom:6px;width:84px;aspect-ratio:3/4;object-fit:cover;border-radius:10px;border:2px solid rgba(255,255,255,.6);background:#222;transform:scaleX(-1)}",
    ".aicall .ai-self[hidden]{display:none}",
    ".aicall .ai-status{text-align:center;font-size:13px;min-height:18px;opacity:.9}",
    ".aicall .ai-level{height:4px;margin:4px 24px 0;border-radius:2px;background:#2a2f3a;overflow:hidden}.aicall .ai-level i{display:block;height:100%;width:0;background:#4ade80;transition:width .08s}",
    ".aicall .ai-caps{flex:1;min-height:0;overflow:auto;margin:8px 12px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.06);font-size:14px;line-height:1.4}",
    ".aicall .cap{margin:0 0 6px}.aicall .cap b{font-weight:600;margin-right:6px;opacity:.8}.aicall .cap.ai b{color:#9ad1ff}.aicall .cap.interim{opacity:.65;font-style:italic}",
    ".aicall .ai-note{text-align:center;font-size:12px;opacity:.75;padding:0 14px 4px}",
    ".aicall .ai-type{display:flex;gap:6px;padding:0 12px 8px}.aicall .ai-type input{flex:1;min-width:0;font-size:16px;padding:8px 10px;border-radius:8px;border:1px solid #444b59;background:#1b1f29;color:#fff}.aicall .ai-type button{border:0;border-radius:8px;background:#2a2f3a;color:#fff;font-weight:600;padding:0 12px;cursor:pointer}",
    ".aicall .ai-bar{display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap;padding:8px 12px 12px;background:#10131a}",
    ".aicall .ai-bar button{min-height:44px;min-width:44px;border-radius:22px;border:0;background:#2a2f3a;color:#fff;cursor:pointer;font-size:13px;font-weight:600;padding:0 14px}",
    ".aicall .ai-bar button:hover,.aicall .ai-bar button:focus-visible{background:#3a4150;outline:2px solid #fff;outline-offset:2px}",
    ".aicall .ai-bar button[aria-pressed=true]{background:#fff;color:#10131a}",
    ".aicall .ai-bar .end{background:#d92d20}.aicall .ai-bar .end:hover{background:#b42318}",
    ".aicall .ai-bar .person{background:#1d4ed8}.aicall .ai-bar .person:hover{background:#1e40af}",
    ".aicall .ai-bar .hold{background:#16a34a}.aicall .ai-bar .hold[aria-pressed=true]{background:#fff;color:#10131a}",
    ".aicall .ai-bar button[hidden]{display:none}",
    ".aicallbar{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;padding:2px 8px}.aicallbar[hidden]{display:none}.aicallbar button{border:0;background:transparent;color:var(--muted,#555);text-decoration:underline;cursor:pointer;font-size:12.5px;padding:3px 6px}",
    ".aicallbar .aicallnote{flex-basis:100%;text-align:center;font-size:12.5px;color:var(--muted,#555)}.aicallbar .aicallnote:empty{display:none}",
    "@media (prefers-reduced-motion:reduce){.aicall .face *,.aicall .face{animation:none!important;transition:none!important}.aicall .face-ring{transform:none}.aicall .face-frame{transform:none}.aicall .face-photo{transform:none}}",
  ].join("\n");

  /* ---------- speech engines ---------- */

  /**
   * The engine the visitor's browser provides. `supported()` says what exists; `listen` keeps a recognizer running (browsers stop it after a pause and it
   * is restarted while wanted); `speak` reads text in sentence-sized pieces (some browsers cut long utterances). A server-side engine would implement the
   * same shape.
   */
  function browserEngine(win) {
    var SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    var synth = win.speechSynthesis;
    var Utter = win.SpeechSynthesisUtterance;
    var rec = null, wanted = false, handlers = null, lang = "en", restartTimer = null, token = 0, speaking = false;

    function supported() { return { stt: !!SR, tts: !!(synth && Utter) }; }

    function startRec() {
      if (!wanted || rec || !SR) return;
      var r;
      try { r = new SR(); } catch (e) { handlers && handlers.onError && handlers.onError("unsupported"); wanted = false; return; }
      r.lang = lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      r.onspeechstart = function () { handlers && handlers.onSpeechStart && handlers.onSpeechStart(); };
      r.onresult = function (e) {
        var interim = "", fin = "";
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var res = e.results[i];
          var txt = res && res[0] ? res[0].transcript : "";
          if (res.isFinal) fin += txt; else interim += txt;
        }
        if (interim.trim() && handlers && handlers.onInterim) handlers.onInterim(interim.trim());
        if (fin.trim() && handlers && handlers.onFinal) handlers.onFinal(fin.trim());
      };
      r.onerror = function (e) {
        var code = e && e.error;
        if (code === "not-allowed" || code === "service-not-allowed") { wanted = false; handlers && handlers.onError && handlers.onError("blocked"); }
        else if (code === "audio-capture") { wanted = false; handlers && handlers.onError && handlers.onError("no_mic"); }
        else if (code === "network") { handlers && handlers.onError && handlers.onError("network"); }
        else if (code === "no-speech") { handlers && handlers.onNoSpeech && handlers.onNoSpeech(); }
      };
      r.onend = function () {
        if (rec === r) rec = null;
        if (wanted) { clearTimeout(restartTimer); restartTimer = setTimeout(startRec, 250); }
        else if (handlers && handlers.onStopped) handlers.onStopped();
      };
      rec = r;
      try { r.start(); } catch (err) { rec = null; if (wanted) { clearTimeout(restartTimer); restartTimer = setTimeout(startRec, 500); } }
    }
    function listen(l, h) { lang = l || "en"; handlers = h; wanted = true; startRec(); }
    function stop() { wanted = false; clearTimeout(restartTimer); if (rec) { try { rec.stop(); } catch (e) { /* already stopped */ } } }
    function abort() { wanted = false; clearTimeout(restartTimer); var r = rec; rec = null; if (r) { try { r.abort(); } catch (e) { /* already stopped */ } } }
    function listening() { return wanted; }

    function pieces(text) {
      var out = [], cur = "";
      (String(text).replace(/\s+/g, " ").match(/[^.!?。！？]+[.!?。！？]*\s*/g) || []).map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (s) {
        if (cur && (cur + " " + s).length > 220) { out.push(cur); cur = s; } else cur = cur ? cur + " " + s : s;
      });
      if (cur) out.push(cur);
      return out;
    }
    function voiceFor(l) {
      try {
        var base = String(l || "en").toLowerCase().split("-")[0];
        var vs = synth.getVoices ? synth.getVoices() : [];
        return vs.filter(function (v) { return String(v.lang).toLowerCase() === String(l).toLowerCase(); })[0] || vs.filter(function (v) { return String(v.lang).toLowerCase().split("-")[0] === base; })[0] || null;
      } catch (e) { return null; }
    }
    function speak(text, l, h) {
      cancel();
      var list = pieces(text), my = ++token, i = 0;
      if (!synth || !Utter || !list.length) { h && h.onEnd && h.onEnd(); return; }
      speaking = true;
      var next = function () {
        if (my !== token) return;
        if (i >= list.length) { speaking = false; h && h.onEnd && h.onEnd(); return; }
        var u = new Utter(list[i++]);
        u.lang = l || "en";
        var v = voiceFor(l); if (v) u.voice = v;
        if (i === 1) u.onstart = function () { if (my === token) h && h.onStart && h.onStart(); };
        u.onboundary = function () { if (my === token) h && h.onBoundary && h.onBoundary(); };
        u.onend = next;
        u.onerror = function () { if (my === token) { speaking = false; h && h.onEnd && h.onEnd(); } };
        synth.speak(u);
      };
      next();
    }
    function cancel() { token++; speaking = false; try { synth && synth.cancel && synth.cancel(); } catch (e) { /* ignore */ } }
    return { name: "browser", supported: supported, listen: listen, stop: stop, abort: abort, listening: listening, speak: speak, cancel: cancel, isSpeaking: function () { return speaking; } };
  }

  /* ---------- the face of the assistant ---------- */

  var FACE_STATES = ["idle", "listening", "thinking", "speaking"];
  /** The face's state machine: what a call event turns the face into. Unknown events and unknown states leave it where it is (or at rest). */
  function faceNext(cur, ev) {
    var map = { listen: "listening", think: "thinking", speak: "speaking", stop: "idle", mute: "idle", end: "listening" };
    if (FACE_STATES.indexOf(cur) < 0) cur = "idle";
    return map[ev] || cur;
  }

  /**
   * A lightweight animated face, no dependencies. Two looks: the agent's PHOTO (never lip-synced: a glow ring and a small scale that follow the level of
   * the voice, a speaking bars indicator, thinking dots) or a stylised SVG face (mouth and blinking follow the voice). The level comes from an
   * AnalyserNode on the assistant's audio when there is one (the realtime engine) and from word boundaries of the browser's voice otherwise. States:
   * idle, listening, thinking, speaking, each also shown without motion (ring colour, indicators) when the visitor prefers reduced motion. The label that
   * says it is an AI is part of the face and cannot be left out. A picture that fails to load turns into the SVG face.
   */
  function createFace(doc, win, o) {
    var NS = "http://www.w3.org/2000/svg";
    var reduce = !!(win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var st = { state: "idle", level: 0, target: 0, analyser: null, data: null, raf: 0, timer: 0, blinkAt: 0, blinking: 0, destroyed: false };
    var root = doc.createElement("div");
    root.className = "face";
    root.setAttribute("role", "img");
    root.setAttribute("aria-label", (o.alt || o.name + ", animated AI avatar") + (o.label ? " (" + o.label + ")" : ""));
    root.setAttribute("data-state", "idle");
    var ring = doc.createElement("div"); ring.className = "face-ring";
    var frame = doc.createElement("div"); frame.className = "face-frame";
    var wave = doc.createElement("div"); wave.className = "face-wave"; wave.setAttribute("aria-hidden", "true");
    var bars = [];
    for (var i = 0; i < 5; i++) { var b = doc.createElement("i"); bars.push(b); wave.appendChild(b); }
    var dots = doc.createElement("div"); dots.className = "face-dots"; dots.setAttribute("aria-hidden", "true");
    for (var j = 0; j < 3; j++) dots.appendChild(doc.createElement("i"));
    var chip = doc.createElement("span"); chip.className = "face-label"; chip.textContent = o.label || "AI";
    [ring, frame, wave, dots, chip].forEach(function (e) { root.appendChild(e); });

    function svgFace() {
      function n(tag, a) { var e = doc.createElementNS(NS, tag); for (var k in a) e.setAttribute(k, a[k]); return e; }
      var svg = n("svg", { class: "face-svg", viewBox: "0 0 150 150", "aria-hidden": "true" });
      svg.appendChild(n("circle", { cx: "75", cy: "75", r: "75", fill: "#2a2f3a" }));
      svg.appendChild(n("circle", { cx: "75", cy: "78", r: "52", fill: "#394152" }));
      svg.appendChild(n("ellipse", { class: "eye", cx: "55", cy: "68", rx: "7", ry: "9", fill: "#fff" }));
      svg.appendChild(n("ellipse", { class: "eye", cx: "95", cy: "68", rx: "7", ry: "9", fill: "#fff" }));
      svg.appendChild(n("ellipse", { class: "mouth", cx: "75", cy: "102", rx: "18", ry: "13", fill: "#fff" }));
      return svg;
    }
    function useSvg() {
      frame.textContent = "";
      frame.appendChild(svgFace());
      root.setAttribute("data-mode", "svg");
      st.mode = "svg";
    }
    function usePhoto(url) {
      var img = doc.createElement("img");
      img.className = "face-photo";
      img.setAttribute("alt", "");
      img.setAttribute("draggable", "false");
      img.setAttribute("referrerpolicy", "no-referrer");
      img.addEventListener("error", function () { if (!st.destroyed && st.mode === "photo") { useSvg(); if (o.onPhotoFail) o.onPhotoFail(); } });
      img.setAttribute("src", url);
      frame.textContent = "";
      frame.appendChild(img);
      root.setAttribute("data-mode", "photo");
      st.mode = "photo";
    }
    if (o.photo) usePhoto(o.photo); else useSvg();

    function readAnalyser() {
      var a = st.analyser;
      if (!a) return null;
      if (!st.data) st.data = new Uint8Array(a.fftSize || 256);
      a.getByteTimeDomainData(st.data);
      var sum = 0;
      for (var k = 0; k < st.data.length; k++) { var v = (st.data[k] - 128) / 128; sum += v * v; }
      return Math.min(1, Math.sqrt(sum / st.data.length) * 3.2);
    }
    /** one animation frame (also called directly by tests with a time in ms) */
    function tick(t) {
      var raw = readAnalyser();
      if (raw === null) { raw = st.target; st.target *= 0.86; }
      st.level += (raw - st.level) * (raw > st.level ? 0.55 : 0.18);
      if (st.level < 0.003) st.level = 0;
      var lvl = st.state === "speaking" ? st.level : st.state === "listening" ? Math.min(0.12, st.level) : 0;
      root.style.setProperty("--lvl", lvl.toFixed(3));
      bars.forEach(function (b, idx) { b.style.setProperty("--b", st.state === "speaking" ? (0.22 + lvl * (0.45 + 0.55 * Math.abs(Math.sin(t / 95 + idx * 1.7)))).toFixed(2) : "0.22"); });
      if (st.mode === "svg") {
        root.style.setProperty("--mouth", st.state === "speaking" ? (0.12 + lvl * 0.95).toFixed(2) : "0.12");
        root.style.setProperty("--tilt", (st.state === "idle" || st.state === "listening" ? Math.sin(t / 2300) * 1.8 : 0).toFixed(2) + "deg");
        if (t >= st.blinkAt) { if (st.blinking) { st.blinking = 0; root.classList.remove("blink"); st.blinkAt = t + 2400 + ((t * 7) % 3100); } else { st.blinking = 1; root.classList.add("blink"); st.blinkAt = t + 130; } }
      } else if (st.state !== "idle") {
        // a photograph is not lip-synced: it breathes a little and follows the voice with its glow
        root.style.setProperty("--px", (Math.sin(t / 1700) * 1.6).toFixed(2) + "px");
        root.style.setProperty("--py", (Math.cos(t / 2100) * 1.2).toFixed(2) + "px");
      }
    }
    function loop(t) {
      st.raf = 0;
      if (st.destroyed || reduce) return;
      tick(t || 0);
      if (st.state !== "idle" || st.level > 0.003) schedule();
    }
    function schedule() {
      if (st.raf || st.destroyed || reduce) return;
      st.raf = win.requestAnimationFrame ? win.requestAnimationFrame(loop) : setTimeout(function () { loop(Date.now()); }, 33);
    }
    function setState(ev) {
      var next = FACE_STATES.indexOf(ev) >= 0 ? ev : faceNext(st.state, ev);
      st.state = next;
      root.setAttribute("data-state", next);
      if (next !== "speaking") st.target = 0;
      if (reduce) tick(0); else schedule();
    }
    return {
      el: root,
      setState: setState,
      /** a burst of voice energy from 0 to 1 (word boundaries of the browser's voice) */
      pulse: function (x) { st.target = Math.max(st.target, Math.min(1, x)); schedule(); },
      /** a real audio level source: an AnalyserNode on the assistant's audio */
      attachAnalyser: function (a) { st.analyser = a; st.data = null; schedule(); },
      tick: tick,
      state: function () { return st.state; },
      mode: function () { return st.mode; },
      destroy: function () { st.destroyed = true; if (st.raf && win.cancelAnimationFrame) win.cancelAnimationFrame(st.raf); }
    };
  }

  /* ---------- the call ---------- */

  function create(o) {
    var doc = o.doc, win = o.win || (doc && doc.defaultView);
    var strings = o.t || function (k, vars) { return fmt(DEFAULTS[k] || k, vars); };
    function t(k, vars) {
      var s = strings(k, vars);
      return s === k && DEFAULTS[k] ? fmt(DEFAULTS[k], vars) : s;
    }
    function fmt(s, vars) { return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] !== undefined ? String(vars[k]) : m; }) : s; }
    var emit = o.emit || function () {};
    var engine = o.engine || browserEngine(win);
    var media = o.mediaDevices || (win && win.navigator && win.navigator.mediaDevices);
    var rtcCtor = o.RTCPeerConnection || (win && win.RTCPeerConnection);
    var fetchFn = o.fetch || (win && win.fetch && win.fetch.bind(win));
    var cfg = (o.config && o.config.ai) || { enabled: false };
    var timing = { promptMs: 20000, endMs: 45000, mergeMs: 700 };
    if (o.timing) for (var tk in o.timing) timing[tk] = o.timing[tk];
    /** the silence prompt and the silence end follow the workspace's idle timeout (default 120 s: prompt at 20 s, end at 45 s), always before the server's own limit */
    function timingFor(idleS) {
      if (o.timing || !idleS) return;
      timing.promptMs = Math.round(Math.min(20000, Math.max(5000, idleS * 170)));
      timing.endMs = Math.round(Math.min(45000, idleS * 375));
    }

    var S = fresh();
    function fresh() {
      return { call: null, ai: null, kind: "voice", lang: "en", phase: "idle", muted: false, ptt: false, held: false, seq: 0, inflight: false, buf: "", mergeTimer: null, promptTimer: null, endTimer: null, prompted: false, since: 0, clock: null, mic: null, meter: null, audioCtx: null, selfStream: null, pending: "", ended: null, speakingTimer: null, typedOnly: false, engineName: "browser", el: null };
    }
    var elRef = null;

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
    function send(event, payload, timeoutMs) {
      return new Promise(function (resolve) {
        var s = socket();
        if (!s) return resolve({ ok: false, error: { code: "OFFLINE", message: "offline" } });
        var done = false, timer = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, error: { code: "TIMEOUT", message: "timeout" } }); } }, timeoutMs || 8000);
        s.emit(event, payload, function (ack) { if (done) return; done = true; clearTimeout(timer); resolve(ack || { ok: false }); });
      });
    }
    function state(phase, extra) {
      S.phase = phase;
      if (elRef) { elRef.root.setAttribute("data-phase", phase); renderStatus(); faceState(phase); }
      if (S.call) emit("ai_call_state", { room_id: S.call.room_id, call_id: S.call.id, state: phase, kind: S.kind, reason: extra || undefined });
    }

    /* ---------- overlay ---------- */
    function build() {
      if (elRef) return elRef;
      var name = h("span", { class: "ai-name" });
      var badge = h("span", { class: "ai-badge" });
      var sub = h("span", { class: "ai-sub", role: "timer" });
      var head = h("div", { class: "ai-head" }, [name, badge, sub]);
      var stageBox = h("div", { class: "ai-stage" });
      var self = h("video", { class: "ai-self", autoplay: true, playsinline: true, muted: true, hidden: true, "aria-label": t("aicall_self_view") });
      self.muted = true;
      var status = h("div", { class: "ai-status", role: "status", "aria-live": "polite" });
      var levelFill = h("i");
      var level = h("div", { class: "ai-level", role: "img", "aria-label": t("aicall_level") }, [levelFill]);
      var caps = h("div", { class: "ai-caps", role: "log", "aria-live": "polite", "aria-label": t("aicall_captions") });
      var note = h("div", { class: "ai-note", text: t("aicall_privacy") });
      var input = h("input", { type: "text", maxlength: "500", "aria-label": t("aicall_type_label"), placeholder: t("aicall_type_label"), autocomplete: "off", enterkeyhint: "send" });
      var typeForm = h("form", { class: "ai-type" }, [input, h("button", { type: "submit", text: t("aicall_type_send") })]);
      typeForm.addEventListener("submit", function (e) { e.preventDefault(); var v = input.value.trim(); if (!v) return; input.value = ""; submitText(v, "typed"); });
      var bar = h("div", { class: "ai-bar" });
      var el = h("section", { class: "aicall", role: "dialog", "aria-modal": "true", "aria-label": t("aicall_title", { name: "" }).trim(), hidden: true }, [head, stageBox, self, status, level, caps, note, typeForm, bar]);
      stageBox.appendChild(self);
      el.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.call && S.phase !== "ended" && S.phase !== "waiting") end("completed"); });
      elRef = { root: el, name: name, badge: badge, sub: sub, stage: stageBox, self: self, status: status, level: level, levelFill: levelFill, caps: caps, input: input, typeForm: typeForm, bar: bar, interim: null };
      o.container.appendChild(el);
      return elRef;
    }
    function renderStatus() {
      if (!elRef) return;
      var p = S.phase, key = p === "starting" ? "aicall_starting" : p === "thinking" ? "aicall_thinking" : p === "speaking" ? "aicall_speaking" : p === "listening" ? (S.muted ? "aicall_muted" : S.ptt && !S.held ? "aicall_ptt_hold" : "aicall_listening") : "";
      elRef.status.textContent = key ? t(key) : "";
    }
    function caption(who, text, interim) {
      var u = build();
      if (interim && who === "ai") {
        if (!u.aiInterim) { u.aiInterim = h("p", { class: "cap interim ai" }, [h("b", { text: S.ai ? S.ai.agent.name : "" }), h("span")]); u.caps.appendChild(u.aiInterim); }
        u.aiInterim.lastChild.textContent = text;
      } else if (interim) {
        if (!u.interim) { u.interim = h("p", { class: "cap interim you" }, [h("b", { text: t("aicall_you") }), h("span")]); u.caps.appendChild(u.interim); }
        u.interim.lastChild.textContent = text;
      } else {
        if (u.aiInterim && who === "ai") { u.aiInterim.parentNode && u.aiInterim.parentNode.removeChild(u.aiInterim); u.aiInterim = null; }
        if (u.interim && who === "you") { u.interim.parentNode && u.interim.parentNode.removeChild(u.interim); u.interim = null; }
        u.caps.appendChild(h("p", { class: "cap " + (who === "ai" ? "ai" : "you"), "data-who": who }, [h("b", { text: who === "ai" ? (S.ai ? S.ai.agent.name : "") : t("aicall_you") }), h("span", { text: text })]));
        if (u.interim) u.caps.appendChild(u.interim);
      }
      u.caps.scrollTop = u.caps.scrollHeight;
    }
    function clearInterim() { if (elRef && elRef.interim) { elRef.interim.parentNode && elRef.interim.parentNode.removeChild(elRef.interim); elRef.interim = null; } }
    function button(cls, label, text, onclick, pressed) {
      return h("button", { type: "button", class: cls, "aria-label": label, "aria-pressed": pressed === undefined ? null : String(pressed), text: text, onclick: onclick });
    }
    function renderBar() {
      var u = build();
      u.bar.textContent = "";
      if (S.phase === "ended") {
        u.bar.appendChild(button("end", t("aicall_close"), t("aicall_close"), function () { teardown(); }));
        var b = u.bar.querySelector("button"); if (b && b.focus) b.focus();
        return;
      }
      if (S.phase === "waiting") {
        u.bar.appendChild(button("end", t("aicall_close"), t("aicall_close"), function () { teardown(); }));
        return;
      }
      u.bar.appendChild(button("mute", t(S.muted ? "aicall_unmute" : "aicall_mute"), S.muted ? "Mic off" : "Mic", function () { toggleMute(); }, S.muted));
      if (!S.typedOnly) {
        u.bar.appendChild(button("ptt", t(S.ptt ? "aicall_ptt_off" : "aicall_ptt_use"), S.ptt ? t("aicall_ptt_off") : t("aicall_ptt_use"), function () { togglePtt(); }, S.ptt));
        if (S.ptt) {
          var hold = button("hold", t("aicall_ptt_hold"), t("aicall_ptt_hold"), function () {}, S.held);
          hold.addEventListener("pointerdown", function (e) { e.preventDefault(); pttDown(); });
          hold.addEventListener("pointerup", function () { pttUp(); });
          hold.addEventListener("pointerleave", function () { if (S.held) pttUp(); });
          hold.addEventListener("keydown", function (e) { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); pttDown(); } });
          hold.addEventListener("keyup", function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); pttUp(); } });
          u.bar.appendChild(hold);
        }
      }
      if (S.kind === "video" && media && media.getUserMedia) u.bar.appendChild(button("cam", t(S.selfStream ? "aicall_camera_hide" : "aicall_camera_show"), S.selfStream ? t("aicall_camera_hide") : t("aicall_camera_show"), function () { toggleSelf(); }, !!S.selfStream));
      u.bar.appendChild(button("person", t("aicall_person"), t("aicall_person"), function () { handoff(); }));
      u.bar.appendChild(button("end", t("aicall_end"), t("aicall_end"), function () { end("completed"); }));
    }
    function renderHeader() {
      if (!elRef || !S.ai) return;
      elRef.name.textContent = t("aicall_title", { name: S.ai.agent.name });
      elRef.badge.textContent = t("aicall_badge", { label: S.ai.agent.label });
      var sec = S.since ? Math.max(0, Math.floor((Date.now() - S.since) / 1000)) : 0;
      elRef.sub.textContent = (sec < 600 ? "0" : "") + Math.floor(sec / 60) + ":" + (sec % 60 < 10 ? "0" : "") + (sec % 60);
      elRef.root.setAttribute("aria-label", t("aicall_title", { name: S.ai.agent.name }));
    }
    /** the assistant's picture: its photo when it has one that loads (this app's own pictures and https addresses), else the drawn face */
    function photoUrl(u) {
      if (!u) return null;
      if (/^\/avatars\/[a-z0-9._-]+$/i.test(u)) return (o.apiBase != null ? o.apiBase : (win && win.location ? win.location.origin : "")) + u;
      return /^https:\/\//i.test(u) ? u : null;
    }
    function renderStage() {
      var u = build();
      var keep = u.self;
      u.stage.textContent = "";
      if (face) face.destroy();
      var a = S.ai && S.ai.agent;
      face = createFace(doc, win, { name: a ? a.name : "", label: a ? a.label : "", photo: photoUrl(a && a.avatar_url), alt: a && a.avatar_alt ? a.avatar_alt : "" });
      u.stage.appendChild(face.el);
      u.stage.appendChild(keep);
      u.root.setAttribute("data-kind", S.kind);
      faceState(S.phase);
    }
    var face = null;
    var FACE_OF = { listening: "listening", thinking: "thinking", speaking: "speaking" };
    function faceState(phase) { if (face) face.setState(S.muted && phase === "listening" ? "idle" : FACE_OF[phase] || "idle"); }
    function mouth(open) { if (face && open) face.pulse(0.35 + Math.random() * 0.65); }

    /* ---------- the microphone: a level meter and an early permission check ---------- */
    /** resolves "ok", "denied" (the visitor or the system refused: typing is the way to talk) or "none" (no media API: the recognizer asks for the microphone itself) */
    function openMic() {
      if (!media || !media.getUserMedia) return Promise.resolve("none");
      return media.getUserMedia({ audio: true }).then(function (stream) {
        S.mic = stream;
        try {
          var Ctx = win.AudioContext || win.webkitAudioContext;
          if (Ctx) {
            S.audioCtx = new Ctx();
            var src = S.audioCtx.createMediaStreamSource(stream);
            var an = S.audioCtx.createAnalyser();
            an.fftSize = 256;
            src.connect(an);
            var data = new Uint8Array(an.frequencyBinCount);
            S.meter = setInterval(function () {
              if (!elRef) return;
              an.getByteTimeDomainData(data);
              var peak = 0;
              for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
              elRef.levelFill.style.width = S.muted ? "0" : Math.min(100, Math.round(peak * 1.6)) + "%";
            }, 100);
          }
        } catch (e) { /* a level meter is a courtesy */ }
        return "ok";
      }).catch(function () { return "denied"; });
    }
    function closeMic() {
      clearInterval(S.meter); S.meter = null;
      if (S.mic) S.mic.getTracks().forEach(function (tr) { tr.stop(); });
      S.mic = null;
      if (S.audioCtx && S.audioCtx.close) { try { S.audioCtx.close(); } catch (e) { /* ignore */ } }
      S.audioCtx = null;
      if (S.selfStream) { S.selfStream.getTracks().forEach(function (tr) { tr.stop(); }); S.selfStream = null; }
    }
    function toggleSelf() {
      if (S.selfStream) { S.selfStream.getTracks().forEach(function (tr) { tr.stop(); }); S.selfStream = null; if (elRef) { elRef.self.srcObject = null; elRef.self.hidden = true; } renderBar(); return; }
      media.getUserMedia({ video: true }).then(function (s) { S.selfStream = s; elRef.self.srcObject = s; elRef.self.hidden = false; renderBar(); }).catch(function () { /* no camera: nothing to show */ });
    }

    /* ---------- listening ---------- */
    function armSilence() {
      clearTimeout(S.promptTimer); clearTimeout(S.endTimer);
      if (!S.call || S.phase === "ended" || S.phase === "waiting") return;
      S.promptTimer = setTimeout(function () {
        if (!S.call || S.phase === "thinking" || S.phase === "speaking") return armSilence();
        S.prompted = true;
        var text = t("aicall_still_there");
        caption("ai", text);
        if (S.engineName === "realtime") dcSend({ type: "response.create", response: { instructions: "Briefly ask the visitor whether they are still there." } });
        sayAloud(text, function () { state("listening"); });
      }, timing.promptMs);
      S.endTimer = setTimeout(function () {
        if (!S.call) return;
        if (S.phase === "thinking" || S.phase === "speaking") return armSilence();
        var text = t("aicall_silence_end");
        caption("ai", text);
        sayAloud(text, function () {});
        end("silence", text);
      }, timing.endMs);
    }
    function heard() { S.prompted = false; armSilence(); }

    function startListening() {
      if (S.engineName === "realtime") return;
      if (S.typedOnly || S.muted || S.phase === "ended" || S.phase === "waiting") return;
      if (S.ptt && !S.held) return;
      engine.listen(S.lang, {
        onInterim: function (text) {
          if (S.muted) return;
          // the visitor talks over the assistant: its voice stops at once
          if (S.phase === "speaking" && text.length >= 2) { engine.cancel(); if (S.speakingTimer) { clearInterval(S.speakingTimer); S.speakingTimer = null; } mouth(false); state("listening"); }
          heard();
          caption("you", (S.buf ? S.buf + " " : "") + text, true);
        },
        onFinal: function (text) {
          if (S.muted) return;
          if (S.phase === "speaking") { engine.cancel(); mouth(false); state("listening"); }
          heard();
          S.buf = (S.buf ? S.buf + " " : "") + text;
          caption("you", S.buf, true);
          clearTimeout(S.mergeTimer);
          // in push-to-talk the release flushes; otherwise a short pause ends the sentence
          if (!S.ptt) S.mergeTimer = setTimeout(flushBuffer, timing.mergeMs);
          else if (!S.held) flushBuffer();
        },
        onSpeechStart: function () { heard(); },
        onNoSpeech: function () {},
        onError: function (code) {
          if (code === "blocked" || code === "no_mic") { S.typedOnly = true; caption("ai", t("aicall_mic_blocked")); renderBar(); }
          else if (code === "unsupported") { S.typedOnly = true; renderBar(); }
        },
      });
      if (S.phase === "starting" || S.phase === "idle") state("listening");
    }
    function stopListening() { clearTimeout(S.mergeTimer); if (S.engineName !== "realtime") engine.stop(); }
    function flushBuffer() {
      clearTimeout(S.mergeTimer);
      var text = S.buf.trim();
      S.buf = "";
      if (!text) return;
      submitText(text, "voice");
    }

    /* ---------- one utterance, one answer ---------- */
    function submitText(text, via) {
      if (!S.call || S.phase === "ended" || S.phase === "waiting") return;
      clearInterim();
      caption("you", text);
      heard();
      if (S.engineName === "realtime") return rtTyped(text);
      // one request at a time: what is said meanwhile is merged and sent after the answer
      if (S.inflight) { S.pending = (S.pending ? S.pending + " " : "") + text; return; }
      S.inflight = true;
      engine.cancel();
      mouth(false);
      state("thinking");
      var body = { call_id: S.call.id, text: text.slice(0, S.ai.max_utterance_chars || 600), seq: ++S.seq, via: via };
      send("aicall:say", body, 45000).then(function (ack) { S.inflight = false; onAnswer(ack, body); });
    }
    function line(kind, serverText) {
      // fixed lines the server sends are spoken in the visitor's language when this page knows it
      var map = { resolved: "aicall_resolved", max_duration: "aicall_time_limit", budget: "aicall_time_limit", idle: "aicall_silence_end", taken_over: "aicall_taken_over", kill_switch: "aicall_ended" };
      return map[kind] ? t(map[kind]) : serverText;
    }
    function onAnswer(ack, body) {
      if (!S.call || S.phase === "ended") return;
      if (!ack || !ack.ok) {
        var code = ack && ack.error && ack.error.code;
        if (code === "RATE_LIMITED") { caption("ai", t("aicall_limit")); state("listening"); return afterAnswer(); }
        if (code === "CALL_STATE" || code === "NOT_FOUND") return showEnded(t("aicall_ended"), "ended");
        if (code === "TIMEOUT" || code === "OFFLINE") { caption("ai", t("aicall_error")); state("listening"); return afterAnswer(); }
        caption("ai", t("aicall_error")); state("listening"); return afterAnswer();
      }
      var r = ack.reply || {};
      if (ack.call) S.call = Object.assign({}, S.call, ack.call);
      var text = r.ended ? line(r.ended.reason, r.text) : r.text;
      if (r.ended && r.ended.reason === "handoff") text = r.ended.human_call ? t("aicall_waiting_person") : t("aicall_waiting_chat");
      var spoken = r.ended ? text : (r.speech || r.text || "");
      if (text) caption("ai", r.ended ? text : r.text);
      if (r.ended) {
        S.ended = r.ended;
        return sayAloud(spoken, function () { finishFromServer(r.ended, text); });
      }
      // the visitor already said more while this was being worked out: that is the next turn, the voice would only be talked over
      if (S.pending) { state("listening"); return afterAnswer(); }
      sayAloud(spoken, function () { state("listening"); afterAnswer(); });
    }
    function afterAnswer() {
      armSilence();
      if (S.pending) { var p = S.pending; S.pending = ""; submitText(p, "voice"); }
    }
    function sayAloud(text, done) {
      if (S.engineName === "realtime") { done(); return; }
      var sup = engine.supported();
      if (!text || !sup.tts || S.phase === "ended") { done(); return; }
      state("speaking");
      var finished = false;
      var finish = function () { if (finished) return; finished = true; if (S.speakingTimer) { clearInterval(S.speakingTimer); S.speakingTimer = null; } mouth(false); if (S.phase === "speaking") done(); };
      engine.speak(text, S.lang, {
        onStart: function () { if (!S.speakingTimer) S.speakingTimer = setInterval(function () { mouth(true); }, 130); },
        onBoundary: function () { mouth(true); },
        onEnd: finish,
      });
      // a barge-in cancelled the voice: the phase moved on, nothing more to do
    }
    function finishFromServer(ended, text) {
      if (ended.reason === "handoff" || ended.reason === "monitor") return waitForPerson(text, !!ended.human_call);
      showEnded(text || t("aicall_ended"), ended.reason);
    }

    /* ---------- hand-over, end ---------- */
    function handoff() {
      if (!S.call || S.phase === "ended" || S.phase === "waiting") return;
      stopListening(); engine.cancel();
      var id = S.call.id;
      send("aicall:handoff", { call_id: id }, 15000).then(function (ack) {
        if (!ack || !ack.ok) {
          var c = ack && ack.error && ack.error.code;
          if (c === "CALL_STATE" || c === "NOT_FOUND") return showEnded(t("aicall_ended"), "ended");
          caption("ai", t("aicall_error")); startListening(); return;
        }
        var text = ack.human_call ? t("aicall_waiting_person") : t("aicall_waiting_chat");
        caption("ai", text);
        sayAloud(text, function () {});
        waitForPerson(text, !!ack.human_call);
      });
    }
    function waitForPerson(text, humanCall) {
      clearTimeout(S.promptTimer); clearTimeout(S.endTimer); clearInterval(S.clock);
      stopListening();
      closeRt();
      state("waiting", humanCall ? "human_call" : "chat");
      var u = build();
      u.typeForm.hidden = true; u.level.hidden = true;
      u.status.textContent = text;
      renderBar();
      if (o.onHandoff) o.onHandoff({ human_call: humanCall });
      // without a call to wait for, the chat is where the person answers: leave the window after the visitor has read it
      if (!humanCall) S.waitClose = setTimeout(function () { if (S.phase === "waiting") teardown(); }, 6000);
    }
    function end(reason, text) {
      var call = S.call;
      if (!call || S.phase === "ended") return;
      clearTimeout(S.promptTimer); clearTimeout(S.endTimer);
      send("aicall:end", { call_id: call.id, reason: reason || "completed" });
      showEnded(text || t("aicall_ended"), reason || "completed");
    }
    function showEnded(text, reason) {
      var u = build();
      clearTimeout(S.promptTimer); clearTimeout(S.endTimer); clearTimeout(S.mergeTimer); clearInterval(S.clock); clearInterval(S.speakingTimer);
      stopListening(); engine.cancel();
      closeRt();
      closeMic();
      state("ended", reason);
      u.typeForm.hidden = true; u.level.hidden = true;
      u.status.textContent = text;
      u.root.hidden = false;
      renderBar();
    }
    function teardown() {
      clearTimeout(S.promptTimer); clearTimeout(S.endTimer); clearTimeout(S.mergeTimer); clearTimeout(S.waitClose); clearInterval(S.clock); clearInterval(S.speakingTimer);
      try { engine.abort(); engine.cancel(); } catch (e) { /* ignore */ }
      closeRt();
      closeMic();
      var el = elRef;
      S = fresh();
      if (el) { el.root.hidden = true; el.caps.textContent = ""; el.interim = null; el.bar.textContent = ""; el.status.textContent = ""; el.typeForm.hidden = false; el.level.hidden = false; el.self.hidden = true; el.self.srcObject = null; }
    }

    /* ---------- controls ---------- */
    function toggleMute() {
      S.muted = !S.muted;
      if (S.mic) S.mic.getAudioTracks().forEach(function (tr) { tr.enabled = !S.muted && !(S.ptt && !S.held); });
      if (S.muted) stopListening(); else startListening();
      faceState(S.phase);
      renderStatus(); renderBar();
    }
    function togglePtt() {
      S.ptt = !S.ptt;
      S.held = false;
      if (S.ptt) stopListening(); else startListening();
      if (S.engineName === "realtime") rtMic(!S.ptt && !S.muted);
      renderStatus(); renderBar();
    }
    function pttDown() {
      if (!S.ptt || S.held || S.muted) return;
      S.held = true;
      if (S.engineName === "realtime") rtMic(true);
      engine.cancel(); mouth(false);
      if (S.phase === "speaking") state("listening");
      startListening();
      renderStatus(); renderBar();
      var b = elRef && elRef.bar.querySelector(".hold"); if (b && b.focus) b.focus();
    }
    function pttUp() {
      if (!S.held) return;
      S.held = false;
      renderStatus();
      // let the recognizer deliver its last words, then send what was said
      setTimeout(function () { stopListening(); flushBuffer(); if (S.engineName === "realtime" && S.ptt && !S.held) rtMic(false); renderBar(); }, 450);
    }

    /* ---------- the realtime engine: this browser talks to the voice service over WebRTC with a secret the server minted for this one call ---------- */
    var RT = null;
    function dcSend(obj) { if (RT && RT.dc && RT.dc.readyState === "open") { try { RT.dc.send(JSON.stringify(obj)); return true; } catch (e) { return false; } } return false; }
    function rtMic(on) { if (S.mic) S.mic.getAudioTracks().forEach(function (tr) { tr.enabled = on; }); }
    function closeRt() {
      var rt = RT;
      RT = null;
      if (!rt) return;
      rt.closing = true;
      clearTimeout(rt.connectTimer); clearTimeout(rt.endTimer); clearTimeout(rt.dropTimer);
      try { rt.dc && rt.dc.close(); } catch (e) { /* closed */ }
      try { rt.pc && rt.pc.close(); } catch (e) { /* closed */ }
      if (rt.audio) { try { rt.audio.srcObject = null; } catch (e) { /* ignore */ } if (rt.audio.parentNode) rt.audio.parentNode.removeChild(rt.audio); }
      if (rt.ctx && rt.ctx.close) { try { rt.ctx.close(); } catch (e) { /* ignore */ } }
    }
    function rtFailed(reason) {
      var rt = RT;
      if (!rt || rt.closing || !S.call) return;
      closeRt();
      // the voice service could not be reached: carry on with this browser's own speech, the visitor does not start over
      send("aicall:fallback", { call_id: S.call.id, reason: reason }).then(function (ack) {
        if (!S.call || S.phase === "ended") return;
        if (!ack || !ack.ok) return showEnded(t("aicall_error"), "error");
        S.engineName = "browser";
        S.ai.engine = "browser";
        caption("ai", t("aicall_switched"));
        if (engine.supported().stt && !S.typedOnly && !S.muted) startListening(); else S.typedOnly = true;
        state("listening");
        renderBar();
        armSilence();
      });
    }
    function startRealtime(info) {
      if (!rtcCtor || !fetchFn) return rtFailed("no_webrtc");
      var rt = RT = { pc: null, dc: null, audio: null, ctx: null, open: false, closing: false, firstAssistant: true, pendingEnd: null, ai: "", connectTimer: null, endTimer: null, dropTimer: null, tools: 0 };
      S.engineName = "realtime";
      var pc = new rtcCtor({});
      rt.pc = pc;
      rt.audio = doc.createElement("audio");
      rt.audio.autoplay = true;
      rt.audio.setAttribute("playsinline", "");
      rt.audio.hidden = true;
      elRef.root.appendChild(rt.audio);
      pc.ontrack = function (e) {
        var stream = (e.streams && e.streams[0]) || null;
        if (!stream) return;
        rt.audio.srcObject = stream;
        var p = rt.audio.play && rt.audio.play();
        if (p && p.catch) p.catch(function () { /* the visitor's tap on the call screen starts sound where the browser needs one */ });
        // the face moves with the real level of the assistant's voice
        try {
          var Ctx = win.AudioContext || win.webkitAudioContext;
          if (Ctx && face) {
            rt.ctx = new Ctx();
            var an = rt.ctx.createAnalyser();
            an.fftSize = 256;
            rt.ctx.createMediaStreamSource(stream).connect(an);
            face.attachAnalyser(an);
          }
        } catch (err) { /* the voice is audible without a level meter */ }
      };
      if (S.mic && S.mic.getAudioTracks().length) S.mic.getAudioTracks().forEach(function (tr) { pc.addTrack(tr, S.mic); });
      else if (pc.addTransceiver) pc.addTransceiver("audio", { direction: "recvonly" });
      var dc = pc.createDataChannel("oai-events");
      rt.dc = dc;
      dc.onopen = function () { rt.open = true; clearTimeout(rt.connectTimer); state("thinking"); dcSend({ type: "response.create" }); armSilence(); };
      dc.onmessage = function (m) { var ev; try { ev = JSON.parse(m.data); } catch (e) { return; } onRtEvent(ev); };
      pc.onconnectionstatechange = function () {
        var st = pc.connectionState;
        if (st === "failed") rtFailed("ice_failed");
        else if (st === "disconnected") { clearTimeout(rt.dropTimer); rt.dropTimer = setTimeout(function () { if (RT === rt && pc.connectionState !== "connected") rtFailed("disconnected"); }, 10000); }
        else if (st === "connected") clearTimeout(rt.dropTimer);
      };
      rt.connectTimer = setTimeout(function () { if (!rt.open) rtFailed("connect_timeout"); }, 12000);
      Promise.resolve(pc.createOffer())
        .then(function (offer) { return Promise.resolve(pc.setLocalDescription(offer)).then(function () { return offer; }); })
        .then(function (offer) { return fetchFn(info.url, { method: "POST", headers: { Authorization: "Bearer " + info.client_secret, "Content-Type": "application/sdp" }, body: offer.sdp }); })
        .then(function (res) { if (!res.ok) throw new Error("provider " + res.status); return res.text(); })
        .then(function (sdp) { return pc.setRemoteDescription({ type: "answer", sdp: sdp }); })
        .catch(function () { rtFailed("connect_failed"); });
    }
    function rtServer(event, payload) { return send(event, payload, 15000); }
    function rtEnded(ended, immediate) {
      var rt = RT;
      if (!S.call || S.phase === "ended") return;
      if (immediate || !rt) { closeRt(); S.ended = ended; return finishFromServer(ended, ended.reason === "monitor" || ended.reason === "handoff" ? (ended.human_call ? t("aicall_waiting_person") : t("aicall_waiting_chat")) : line(ended.reason, t("aicall_ended"))); }
      // the model may say goodbye first (a hand-over, a resolution); a short fuse makes sure the call still closes
      rt.pendingEnd = ended;
      rt.endTimer = setTimeout(function () { if (RT === rt && rt.pendingEnd) rtEnded(ended, true); }, 8000);
    }
    function rtTranscript(role, text, itemId, extra) {
      if (!S.call || !text) return;
      rtServer("aicall:transcript", Object.assign({ call_id: S.call.id, role: role, text: text.slice(0, 4000), item_id: String(itemId || ("t" + Date.now())) }, extra || {})).then(function (ack) {
        if (ack && ack.ok && ack.ended) rtEnded(ack.ended, ack.ended.reason === "monitor" || ack.ended.reason === "kill_switch" || ack.ended.reason === "taken_over");
        else if (ack && !ack.ok && ack.error && ack.error.code === "CALL_STATE") { if (S.phase !== "ended" && S.phase !== "waiting") { closeRt(); showEnded(t("aicall_ended"), "ended"); } }
      });
    }
    function rtTyped(text) {
      caption("you", text);
      heard();
      state("thinking");
      dcSend({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: text }] } });
      dcSend({ type: "response.create" });
      rtTranscript("user", text, "typed-" + (++S.seq), { via: "typed" });
    }
    function rtTools(items) {
      var rt = RT;
      if (!rt) return;
      var left = items.length;
      var done = function () { if (--left > 0) return; if (RT === rt) dcSend({ type: "response.create" }); };
      items.forEach(function (it) {
        rtServer("aicall:tool", { call_id: S.call.id, name: String(it.name || "").slice(0, 40), arguments: String(it.arguments || "{}").slice(0, 4000) }).then(function (ack) {
          var out = ack && ack.ok ? ack.output || "{}" : JSON.stringify({ error: (ack && ack.error && ack.error.message) || "The action failed" });
          if (ack && ack.ok && ack.ended && (ack.ended.reason === "monitor" || ack.ended.reason === "kill_switch" || ack.ended.reason === "taken_over")) return rtEnded(ack.ended, true);
          dcSend({ type: "conversation.item.create", item: { type: "function_call_output", call_id: it.call_id, output: out } });
          if (ack && ack.ok && ack.ended) rtEnded(ack.ended, false);
          done();
        });
      });
    }
    function onRtEvent(ev) {
      var rt = RT;
      if (!rt || !S.call || S.phase === "ended" || S.phase === "waiting") return;
      switch (ev.type) {
        case "input_audio_buffer.speech_started": state("listening"); heard(); break;
        case "input_audio_buffer.speech_stopped": state("thinking"); break;
        case "response.created": if (S.phase !== "speaking") state("thinking"); break;
        case "output_audio_buffer.started": state("speaking"); break;
        case "response.output_audio_transcript.delta": state("speaking"); rt.ai += ev.delta || ""; caption("ai", rt.ai, true); break;
        case "response.output_audio_transcript.done": {
          var text = (ev.transcript || rt.ai || "").trim();
          rt.ai = "";
          if (text) { caption("ai", text); rtTranscript("assistant", text, ev.item_id, rt.firstAssistant ? { greeting: true } : {}); }
          rt.firstAssistant = false;
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          var said = (ev.transcript || "").trim();
          if (said) { caption("you", said); heard(); rtTranscript("user", said, ev.item_id); }
          break;
        }
        case "response.done": {
          var calls = ((ev.response && ev.response.output) || []).filter(function (x) { return x && x.type === "function_call"; });
          if (calls.length) { rtTools(calls); break; }
          if (rt.pendingEnd) { var pe = rt.pendingEnd; rt.pendingEnd = null; return rtEnded(pe, true); }
          state("listening");
          armSilence();
          break;
        }
        default: break;
      }
    }

    /* ---------- starting ---------- */
    function start(kind) {
      kind = kind === "video" ? "video" : "voice";
      if (S.call) return Promise.resolve({ ok: false, error: { code: "CALL_IN_PROGRESS" } });
      var sup = engine.supported();
      var canRealtime = !!(cfg.realtime && rtcCtor && fetchFn && media && media.getUserMedia);
      if (!sup.stt && !canRealtime) {
        emit("ai_call_unsupported", { room_id: o.getRoomId && o.getRoomId(), reason: "no_speech_recognition" });
        if (o.onFallback) o.onFallback("unsupported");
        return Promise.resolve({ ok: false, error: { code: "UNSUPPORTED" } });
      }
      S.kind = kind;
      var u = build();
      u.root.hidden = false;
      u.typeForm.hidden = false; u.level.hidden = false;
      u.caps.textContent = "";
      u.status.textContent = t("aicall_starting");
      S.phase = "starting";
      u.root.setAttribute("data-phase", "starting");
      var locale = (win && win.navigator && (win.navigator.language || (win.navigator.languages || [])[0])) || "en";
      return openMic().then(function (mic) {
        return send("aicall:start", { room_id: o.getRoomId(), kind: kind, locale: locale, speech: { stt: sup.stt, tts: sup.tts, webrtc: !!(rtcCtor && fetchFn) } }, 20000).then(function (ack) {
          if (!ack.ok) {
            var code = ack.error && ack.error.code;
            closeMic();
            var msg = code === "AI_BUSY" || code === "AI_DAILY_LIMIT" ? t("aicall_busy") : code === "RATE_LIMITED" ? t("aicall_limit") : code === "AI_CALL_UNAVAILABLE" || code === "AI_CALLS_DISABLED" || code === "AI_CALL_KIND_DISABLED" || code === "HUMAN_HANDLING" ? t("aicall_unavailable") : t("aicall_error");
            S.call = null; S.phase = "idle";
            showEndedNoCall(msg);
            return ack;
          }
          S.call = ack.call; S.ai = ack.ai; S.lang = ack.ai.speech_lang || "en"; S.since = Date.now();
          timingFor(ack.ai.idle_timeout_s);
          if (mic === "denied") S.typedOnly = true;
          renderStage(); renderHeader(); renderBar();
          S.clock = setInterval(renderHeader, 1000);
          if (mic === "denied") caption("ai", t("aicall_mic_blocked"));
          if (kind === "video") { var nt = h("div", { class: "ai-note", text: t("aicall_video_note") }); u.root.insertBefore(nt, u.status); S.videoNote = nt; }
          caption("ai", ack.ai.greeting);
          S.engineName = ack.ai.engine === "realtime" && ack.ai.realtime ? "realtime" : "browser";
          if (S.engineName === "realtime") {
            var rn = h("div", { class: "ai-note", text: t("aicall_realtime_note") });
            u.root.insertBefore(rn, u.status);
            state("thinking");
            startRealtime(ack.ai.realtime);
            return ack;
          }
          // a browser without speech recognition cannot use the browser engine: the text chat is the way to talk to the assistant
          if (!sup.stt) {
            send("aicall:end", { call_id: S.call.id, reason: "unsupported" });
            teardown();
            emit("ai_call_unsupported", { room_id: o.getRoomId && o.getRoomId(), reason: "no_speech_recognition" });
            if (o.onFallback) o.onFallback("unsupported");
            return ack;
          }
          state("listening");
          // the greeting is spoken; listening starts at once so the visitor can interrupt it
          sayAloud(ack.ai.greeting, function () { state("listening"); armSilence(); });
          if (!S.typedOnly) startListening();
          armSilence();
          return ack;
        });
      });
    }
    function showEndedNoCall(msg) {
      var u = build();
      u.status.textContent = msg;
      u.typeForm.hidden = true; u.level.hidden = true;
      S.phase = "ended";
      u.root.setAttribute("data-phase", "ended");
      renderBar();
    }

    /* ---------- events from the server ---------- */
    function onCallState(p) {
      var call = p && p.call;
      if (!call || (o.getRoomId && call.room_id !== o.getRoomId())) return;
      // a person rings while the visitor waits: the ordinary incoming-call screen takes over
      if (call.transport !== "ai" && call.state === "ringing" && S.phase === "waiting") { teardown(); return; }
      if (call.transport !== "ai" || !S.call || call.id !== S.call.id) return;
      S.call = Object.assign({}, S.call, call);
      if (call.state === "ended" && S.phase !== "ended" && S.phase !== "waiting") {
        var why = call.end_reason;
        if (why === "handoff" || why === "monitor") { closeRt(); return waitForPerson(t("aicall_waiting_chat"), false); }
        closeRt();
        showEnded(why === "max_duration" || why === "budget" ? t("aicall_time_limit") : why === "idle" ? t("aicall_silence_end") : why === "taken_over" ? t("aicall_taken_over") : t("aicall_ended"), why);
      } else if (call.state === "failed" && S.phase !== "ended") showEnded(t("aicall_error"), "error");
    }
    function onSocketConnected() {
      var call = S.call;
      if (!call || S.phase === "ended" || S.phase === "waiting") return;
      send("call:resume", { call_id: call.id }).then(function (ack) { if (!ack.ok) showEnded(t("aicall_ended"), "ended"); });
    }
    function bind(s) {
      s.on("call:state", onCallState);
      s.on("connect", onSocketConnected);
    }

    /** The buttons under the message list. In a browser without speech recognition they explain why and send the visitor to the text chat. */
    function bar() {
      if (!cfg || !cfg.enabled) return null;
      var wrap = h("div", { class: "aicallbar" });
      var note = h("span", { class: "aicallnote", role: "status" });
      function go(kind) {
        note.textContent = "";
        if (!engine.supported().stt) { note.textContent = t("aicall_unsupported"); emit("ai_call_unsupported", { room_id: o.getRoomId && o.getRoomId(), reason: "no_speech_recognition" }); if (o.onFallback) o.onFallback("unsupported"); return; }
        start(kind);
      }
      if (cfg.voice !== false) wrap.appendChild(h("button", { type: "button", "data-ai-call": "voice", text: t("aicall_voice"), onclick: function () { go("voice"); } }));
      if (cfg.video !== false) wrap.appendChild(h("button", { type: "button", "data-ai-call": "video", text: t("aicall_video"), onclick: function () { go("video"); } }));
      wrap.appendChild(note);
      return wrap;
    }

    return {
      bind: bind, start: start, bar: bar, end: function () { end("completed"); }, onCallState: onCallState, onSocketConnected: onSocketConnected, handoff: handoff,
      state: function () { return { phase: S.phase, call: S.call }; },
      destroy: function () { teardown(); if (elRef && elRef.root.parentNode) elRef.root.parentNode.removeChild(elRef.root); elRef = null; },
      _S: function () { return S; },
    };
  }

  return { create: create, css: CSS, DEFAULTS: DEFAULTS, browserEngine: browserEngine, createFace: createFace, faceNext: faceNext, FACE_STATES: FACE_STATES };
});
