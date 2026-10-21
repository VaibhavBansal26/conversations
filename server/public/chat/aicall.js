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
  };

  /** CSS for the overlay (the widget injects it into its shadow root; the hosted chat links chat.css and adds this). Dark like the call screen. */
  var CSS = [
    ".aicall{position:absolute;inset:0;z-index:31;display:flex;flex-direction:column;background:#10131a;color:#fff;font-family:inherit}",
    ".aicall[hidden]{display:none}",
    ".aicall .ai-head{padding:12px 14px 6px;text-align:center}",
    ".aicall .ai-name{font-size:16px;font-weight:600}",
    ".aicall .ai-badge{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;background:#2a2f3a;font-size:12px;font-weight:600;color:#cfd5df}",
    ".aicall .ai-sub{display:block;font-size:12.5px;opacity:.85;margin-top:3px;font-variant-numeric:tabular-nums}",
    ".aicall .ai-stage{position:relative;display:flex;align-items:center;justify-content:center;min-height:120px;padding:8px 0;flex:0 0 auto}",
    ".aicall .ai-orb{width:96px;height:96px;border-radius:50%;background:#2a2f3a center/cover no-repeat;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;box-shadow:0 0 0 0 rgba(255,255,255,.35);transition:box-shadow .15s}",
    ".aicall[data-phase=speaking] .ai-orb{animation:aipulse 1.1s ease-in-out infinite}",
    ".aicall[data-phase=listening] .ai-orb{box-shadow:0 0 0 6px rgba(74,222,128,.35)}",
    ".aicall[data-phase=thinking] .ai-orb{opacity:.75}",
    "@keyframes aipulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.4)}50%{box-shadow:0 0 0 14px rgba(255,255,255,.08)}}",
    ".aicall .ai-avatar{width:150px;height:150px}",
    ".aicall .ai-avatar .mouth{transform-origin:50% 50%;transform:scaleY(.15);transition:transform .08s}",
    ".aicall .ai-avatar .glow{opacity:0;transition:opacity .2s}",
    ".aicall[data-phase=speaking] .ai-avatar .glow{opacity:1}",
    ".aicall[data-phase=thinking] .ai-avatar .eye{animation:aiblink 1.4s infinite}",
    "@keyframes aiblink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}",
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
    "@media (prefers-reduced-motion:reduce){.aicall .ai-orb,.aicall .ai-avatar *{animation:none!important;transition:none!important}}",
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
      return { call: null, ai: null, kind: "voice", lang: "en", phase: "idle", muted: false, ptt: false, held: false, seq: 0, inflight: false, buf: "", mergeTimer: null, promptTimer: null, endTimer: null, prompted: false, since: 0, clock: null, mic: null, meter: null, audioCtx: null, selfStream: null, pending: "", ended: null, speakingTimer: null, typedOnly: false, el: null };
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
      if (elRef) { elRef.root.setAttribute("data-phase", phase); renderStatus(); }
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
      if (interim) {
        if (!u.interim) { u.interim = h("p", { class: "cap interim you" }, [h("b", { text: t("aicall_you") }), h("span")]); u.caps.appendChild(u.interim); }
        u.interim.lastChild.textContent = text;
      } else {
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
    /** the picture of the assistant: its avatar picture (voice) or an animated drawing (video). Nothing here is the visitor's. */
    function renderStage() {
      var u = build();
      var keep = u.self;
      u.stage.textContent = "";
      if (S.kind === "video") u.stage.appendChild(avatarSvg(S.ai));
      else {
        var url = S.ai && S.ai.agent.avatar_url;
        var orb = h("div", { class: "ai-orb", "aria-hidden": "true", text: url ? "" : (S.ai && S.ai.agent.name ? S.ai.agent.name.charAt(0).toUpperCase() : "A") });
        if (url && /^https:\/\//i.test(url)) orb.style.backgroundImage = "url(\"" + url.replace(/["\\()]/g, "") + "\")";
        u.stage.appendChild(orb);
      }
      u.stage.appendChild(keep);
    }
    function avatarSvg(ai) {
      var NS = "http://www.w3.org/2000/svg";
      function n(tag, a) { var e = doc.createElementNS(NS, tag); for (var k in a) e.setAttribute(k, a[k]); return e; }
      var svg = n("svg", { class: "ai-avatar", viewBox: "0 0 150 150", role: "img", "aria-label": t("aicall_avatar", { name: ai ? ai.agent.name : "" }) });
      svg.appendChild(n("circle", { class: "glow", cx: "75", cy: "75", r: "72", fill: "none", stroke: "#9ad1ff", "stroke-width": "3" }));
      svg.appendChild(n("circle", { cx: "75", cy: "75", r: "62", fill: "#2a2f3a" }));
      svg.appendChild(n("circle", { cx: "75", cy: "75", r: "62", fill: "none", stroke: "#4b5568", "stroke-width": "2" }));
      svg.appendChild(n("ellipse", { class: "eye", cx: "55", cy: "62", rx: "7", ry: "9", fill: "#fff" }));
      svg.appendChild(n("ellipse", { class: "eye", cx: "95", cy: "62", rx: "7", ry: "9", fill: "#fff" }));
      svg.appendChild(n("ellipse", { class: "mouth", cx: "75", cy: "98", rx: "20", ry: "14", fill: "#fff" }));
      return svg;
    }
    /** the mouth follows what is being said: the browser reports word boundaries, and between them it relaxes */
    function mouth(open) {
      if (!elRef) return;
      var m = elRef.stage.querySelector(".mouth");
      if (m) m.style.transform = "scaleY(" + (open ? (0.35 + Math.random() * 0.65).toFixed(2) : "0.15") + ")";
    }

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
    function stopListening() { clearTimeout(S.mergeTimer); engine.stop(); }
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
      var map = { resolved: "aicall_resolved", max_duration: "aicall_time_limit", idle: "aicall_silence_end", taken_over: "aicall_taken_over" };
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
      var sup = engine.supported();
      if (!text || !sup.tts || S.phase === "ended") { done(); return; }
      state("speaking");
      var finished = false;
      var finish = function () { if (finished) return; finished = true; if (S.speakingTimer) { clearInterval(S.speakingTimer); S.speakingTimer = null; } mouth(false); if (S.phase === "speaking") done(); };
      engine.speak(text, S.lang, {
        onStart: function () { if (S.kind === "video" && !S.speakingTimer) S.speakingTimer = setInterval(function () { mouth(true); }, 130); },
        onBoundary: function () { mouth(true); },
        onEnd: finish,
      });
      // a barge-in cancelled the voice: the phase moved on, nothing more to do
    }
    function finishFromServer(ended, text) {
      if (ended.reason === "handoff") return waitForPerson(text, !!ended.human_call);
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
      closeMic();
      var el = elRef;
      S = fresh();
      if (el) { el.root.hidden = true; el.caps.textContent = ""; el.interim = null; el.bar.textContent = ""; el.status.textContent = ""; el.typeForm.hidden = false; el.level.hidden = false; el.self.hidden = true; el.self.srcObject = null; }
    }

    /* ---------- controls ---------- */
    function toggleMute() {
      S.muted = !S.muted;
      if (S.mic) S.mic.getAudioTracks().forEach(function (tr) { tr.enabled = !S.muted; });
      if (S.muted) stopListening(); else startListening();
      renderStatus(); renderBar();
    }
    function togglePtt() {
      S.ptt = !S.ptt;
      S.held = false;
      if (S.ptt) stopListening(); else startListening();
      renderStatus(); renderBar();
    }
    function pttDown() {
      if (!S.ptt || S.held || S.muted) return;
      S.held = true;
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
      setTimeout(function () { stopListening(); flushBuffer(); renderBar(); }, 450);
    }

    /* ---------- starting ---------- */
    function start(kind) {
      kind = kind === "video" ? "video" : "voice";
      if (S.call) return Promise.resolve({ ok: false, error: { code: "CALL_IN_PROGRESS" } });
      var sup = engine.supported();
      if (!sup.stt) {
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
        return send("aicall:start", { room_id: o.getRoomId(), kind: kind, locale: locale, speech: { stt: sup.stt, tts: sup.tts } }, 20000).then(function (ack) {
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
        if (why === "handoff") return waitForPerson(t("aicall_waiting_chat"), false);
        showEnded(why === "max_duration" ? t("aicall_time_limit") : why === "idle" ? t("aicall_silence_end") : why === "taken_over" ? t("aicall_taken_over") : t("aicall_ended"), why);
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

  return { create: create, css: CSS, DEFAULTS: DEFAULTS, browserEngine: browserEngine };
});
