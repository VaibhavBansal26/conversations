/*!
 * Conversations hosted chat (/chat). Framework-free, runs in a native web view, an iframe or a mobile browser.
 * Talks to the app that served it (same origin): /public/*, Socket.IO namespace /ws/<workspaceId>. Host integration: bridge.js (protocol v1).
 * Docs: docs/MOBILE-BRIDGE.md.
 */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";
  var Bridge = global.ConversationsBridge;
  var I18n = global.ConversationsI18n;
  var doc = global.document;
  var PAGE = 30;
  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  var EMOJI = ["😀", "😁", "😂", "🙂", "😉", "😊", "😍", "😘", "😎", "🤔", "😅", "😢", "😭", "😡", "🙏", "👍", "👎", "👏", "🙌", "💪", "👋", "🤝", "👌", "✌️", "❤️", "💔", "🔥", "✨", "🎉", "✅", "❌", "⚠️", "📎", "📷", "📞", "📧", "⏰", "💬", "🚀", "😴"];

  /* ---------- parameters ---------- */
  var q = new URLSearchParams(global.location.search);
  function param(k) { var v = q.get(k); return v === null || v === "" ? undefined : v; }
  var P = {
    token: param("token") || "",
    name: param("name"), email: param("email"), phone: param("phone"),
    external_id: param("external_id"), identity_hash: param("identity_hash"),
    locale: param("locale"), theme: param("theme"), primary_color: param("primary_color"),
    bridge: param("bridge"), safe_area: param("safe_area") === "1", device_id: param("device_id"),
    close_button: param("close_button") === "1", debug: param("debug") === "1",
  };

  var DOMAIN = (doc.querySelector('meta[name="cv-domain"]') || {}).content || "";

  /* ---------- small helpers ---------- */
  function uuid() {
    var c = global.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    var s = "";
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, 8) + "-" + s.slice(8, 12) + "-4" + s.slice(13, 16) + "-a" + s.slice(17, 20) + "-" + s.slice(20, 32);
  }
  function safeStorage() {
    try {
      var s = global.localStorage;
      s.setItem("__cv_probe", "1");
      s.removeItem("__cv_probe");
      return s;
    } catch (e) {
      var mem = {};
      return { getItem: function (k) { return k in mem ? mem[k] : null; }, setItem: function (k, v) { mem[k] = String(v); }, removeItem: function (k) { delete mem[k]; } };
    }
  }
  function h(tag, attrs, children) {
    var el = doc.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    (children || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  var ICONS = {
    send: ["m22 2-7 20-4-9-9-4z", "M22 2 11 13"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    clip: ["m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"],
    smile: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M8 14s1.5 2 4 2 4-2 4-2", "M9 9h.01", "M15 9h.01"],
  };
  function icon(name, size) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", size || 22); svg.setAttribute("height", size || 22);
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
    ICONS[name].forEach(function (d) { var p = doc.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); });
    return svg;
  }
  function readableOn(hex) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lin = function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    var L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.4 ? "#15151c" : "#ffffff";
  }
  function jitter(ms) { return Math.round(ms * (0.5 + Math.random())); }

  /* ---------- state ---------- */
  var store = safeStorage();
  var keyPrefix = "cvh_" + P.token.slice(-8) + "_";
  var state = {
    config: null, session: null, room: null, messages: [], pending: {}, socket: null, connected: false, view: "boot",
    unread: 0, typingTimer: null, pollTimer: null, lastReadId: null, error: "", info: "", moreOlder: false, loadingOlder: false,
    visible: !doc.hidden, online: global.navigator.onLine !== false, locale: P.locale || (global.navigator.language || "en"), strings: {},
    identity: null, attrs: {}, attrsSent: false, attachments: [], started: false, roomStatus: null, drainWait: null, closedAnnounced: false,
  };
  var els = {};
  var t = I18n.translator(state.locale, state.strings);

  var deviceId = P.device_id && /^[A-Za-z0-9_-]{8,64}$/.test(P.device_id) ? P.device_id : store.getItem(keyPrefix + "device");
  if (!deviceId) deviceId = "d" + uuid().replace(/-/g, "");
  store.setItem(keyPrefix + "device", deviceId);
  try { state.session = JSON.parse(store.getItem(keyPrefix + "session") || "null"); } catch (e) { state.session = null; }
  if (P.name || P.email || P.phone || P.external_id) {
    state.identity = { name: P.name, email: P.email, phone: P.phone, external_id: P.external_id, identity_hash: P.identity_hash };
  }

  /* ---------- bridge ---------- */
  var handlers = {}; // filled with the host commands below; the bridge reads handlers[type] when a command arrives
  var bridge = Bridge.createBridge({
    transport: Bridge.detectTransport(global, P.bridge, DOMAIN),
    handlers: handlers,
    onDrop: function (reason, info) { if (P.debug && global.console) global.console.debug("[bridge] dropped", reason, info); },
  });
  function emit(type, payload) { bridge.emit(type, payload); }

  // host -> page: native hosts call ConversationsBridge.receive(json); iframe hosts use postMessage (origin and source checked)
  global.ConversationsBridge.receive = function (raw) { bridge.receive(raw); };
  if (bridge.transport.name === "iframe") {
    global.addEventListener("message", function (e) {
      var fromParent = e.source === global.parent;
      var allowed = fromParent && Bridge.originMatches(e.origin, DOMAIN);
      bridge.receive(e.data, { allowed: allowed });
    });
  }

  /* ---------- http ---------- */
  function api(path, o) {
    o = o || {};
    var headers = { "x-api-key": P.token, "x-device-id": deviceId, "x-hosted-chat": "1" };
    if (state.session && !o.noSession) headers["x-support-session"] = state.session.session_token;
    var body;
    if (o.form) body = o.form;
    else if (o.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.body); }
    return global.fetch(path, { method: o.method || "GET", headers: headers, body: body, credentials: "omit" }).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error && data.error.message) || "Request failed");
          err.status = res.status; err.code = data && data.error && data.error.code; err.details = data && data.error && data.error.details;
          var ra = Number(res.headers.get("retry-after")); err.retryAfter = ra > 0 ? ra : 0;
          throw err;
        }
        return data;
      });
    });
  }
  /** GET with a few jittered retries for 429/5xx/network errors (reconnect storms must not synchronise). */
  function apiRetry(path, o, tries) {
    tries = tries === undefined ? 3 : tries;
    return api(path, o).catch(function (e) {
      var transient = !e.status || e.status === 429 || e.status >= 500;
      if (!transient || tries <= 0) throw e;
      var wait = e.retryAfter ? e.retryAfter * 1000 : 800 * Math.pow(2, 3 - tries);
      return new Promise(function (r) { setTimeout(r, jitter(wait)); }).then(function () { return apiRetry(path, o, tries - 1); });
    });
  }

  /* ---------- theme, language ---------- */
  function effectiveTheme() {
    var th = doc.documentElement.getAttribute("data-theme");
    if (th === "light" || th === "dark") return th;
    return global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function setTheme(theme) {
    var root = doc.documentElement;
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme); else root.setAttribute("data-theme", "auto");
  }
  function applyColors(primary, text) {
    var root = doc.documentElement.style;
    if (primary) { root.setProperty("--c", primary); root.setProperty("--t", text || readableOn(primary)); }
  }
  function applyLocale() {
    t = I18n.translator(state.locale, state.strings);
    doc.documentElement.setAttribute("lang", state.locale);
    doc.documentElement.setAttribute("dir", I18n.isRtl(state.locale) ? "rtl" : "ltr");
    doc.title = state.config ? state.config.widget.title : "Chat";
  }

  /* ---------- messages ---------- */
  function findIndex(m) {
    for (var i = 0; i < state.messages.length; i++) {
      var x = state.messages[i];
      if ((m.id && x.id === m.id) || (m.client_msg_id && x.client_msg_id === m.client_msg_id)) return i;
    }
    return -1;
  }
  function upsert(m) {
    var i = findIndex(m);
    if (i >= 0) {
      state.messages[i] = Object.assign({}, state.messages[i], m, { local: false });
      delete state.pending[m.client_msg_id];
      return false;
    }
    state.messages.push(m);
    return true;
  }
  function sorted() {
    return state.messages.slice().sort(function (a, b) {
      if (a.local && !b.local) return 1;
      if (b.local && !a.local) return -1;
      if (a.seq != null && b.seq != null) return a.seq - b.seq;
      return 0;
    });
  }
  function mergeServerPage(list, replaceAll) {
    var local = state.messages.filter(function (m) { return m.local; });
    var map = {};
    (replaceAll ? [] : state.messages.filter(function (m) { return !m.local; })).concat(list).forEach(function (m) { map[m.id] = m; });
    var merged = Object.keys(map).map(function (k) { return map[k]; });
    state.messages = merged.concat(local.filter(function (m) { return !merged.some(function (x) { return x.client_msg_id && x.client_msg_id === m.client_msg_id; }); }));
  }
  function oldestServerId() {
    var s = sorted().filter(function (m) { return m.id && !m.local; });
    return s.length ? s[0].id : null;
  }

  /* ---------- rendering ---------- */
  var URL_RE = /(https?:\/\/[^\s<]+)/g;
  function linkify(text, source) {
    var frag = doc.createDocumentFragment(), last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      var url = m[1].replace(/[.,;:!?)]+$/, "");
      var a = h("a", { href: url, "data-cv-link": source || "message", rel: "noopener noreferrer nofollow", text: url });
      frag.appendChild(a);
      last = m.index + url.length;
      URL_RE.lastIndex = last;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    return frag;
  }
  function fmtTime(iso) {
    try { return new Intl.DateTimeFormat(state.locale, { hour: "numeric", minute: "2-digit" }).format(new Date(iso)); } catch (e) { return ""; }
  }
  function formatMoney(minor, currency) {
    try {
      var f = new Intl.NumberFormat(state.locale, { style: "currency", currency: String(currency).toUpperCase() });
      return f.format(minor / Math.pow(10, f.resolvedOptions().maximumFractionDigits));
    } catch (e) { return (minor / 100).toFixed(2) + " " + String(currency).toUpperCase(); }
  }
  function isNearBottom() { var l = els.list; return !l || l.scrollHeight - l.scrollTop - l.clientHeight < 90; }
  function scrollToBottom() { if (els.list) els.list.scrollTop = els.list.scrollHeight; if (els.jump) els.jump.hidden = true; }

  function renderHeader() {
    var w = state.config.widget;
    els.head.textContent = "";
    if (w.logo_url && /^https:\/\//.test(w.logo_url)) els.head.appendChild(h("img", { src: w.logo_url, alt: "" }));
    var sub = h("div", { class: "sub" });
    var online = state.config.agents_available > 0 && state.config.office_open !== false;
    if (online) sub.appendChild(h("span", { class: "on", "aria-hidden": "true" }));
    sub.appendChild(doc.createTextNode(w.intro));
    els.head.appendChild(h("div", { class: "who" }, [h("div", { class: "ttl", role: "heading", "aria-level": "1", text: w.title }), sub]));
    if (P.close_button || bridge.transport.name !== "none") {
      if (P.close_button) els.head.appendChild(h("button", { type: "button", class: "icon-btn", "aria-label": t("close"), onclick: function () { emit("close_requested", {}); } }, [icon("x", 22)]));
    }
  }

  function renderMessages(opts) {
    opts = opts || {};
    var list = els.list;
    if (!list) return;
    var wasBottom = isNearBottom();
    var prevH = list.scrollHeight, prevTop = list.scrollTop;
    list.textContent = "";
    if (state.moreOlder) {
      list.appendChild(h("button", { type: "button", class: "older", "data-older": "1", text: state.loadingOlder ? t("loading_older") : t("load_older"), onclick: loadOlder }));
    }
    sorted().forEach(function (m) {
      if (m.deleted) return;
      var sender = m.sender || {};
      var mine = sender.type === "contact";
      var failed = m.status === "failed" || m.delivery === "failed";
      var cls = "m " + (sender.type === "system" ? "sys" : mine ? "out" : "in") + (sender.type === "bot" ? " bot" : "") + (failed && mine ? " failed" : "");
      var body = h("div", { class: cls, "data-id": m.id || null, "data-qid": m.client_msg_id || null });
      if (!mine && sender.type !== "system" && sender.name) {
        var who = h("span", { class: "who", text: sender.name });
        if (m.meta && m.meta.ai) who.appendChild(h("span", { class: "tag", text: t("ai_tag") }));
        body.appendChild(who);
      }
      var text = m.content_text != null ? m.content_text : m.content || "";
      var card = m.meta && m.meta.card && m.meta.card.type === "payment_request" ? m.meta.card : null;
      if (card) {
        body.className += " pay " + String(card.status).replace(/[^a-z]/g, "");
        body.appendChild(h("span", { class: "amt", text: formatMoney(card.amount, card.currency) }));
        body.appendChild(h("span", { text: String(card.description || "") }));
        body.appendChild(h("span", { class: "st", text: t("pay_" + String(card.status).replace(/[^a-z]/g, "")) }));
        if (card.status === "open" && /^https:\/\//.test(card.url || "")) body.appendChild(h("a", { class: "btn", href: card.url, "data-cv-link": "payment", rel: "noopener noreferrer", text: t("pay_now") }));
      } else if (text) {
        var span = h("span");
        span.appendChild(linkify(text, "message"));
        body.appendChild(span);
      }
      (m.attachments || []).forEach(function (a) { body.appendChild(attachmentNode(a)); });
      if (m.localAttachments) m.localAttachments.forEach(function (a) { body.appendChild(attachmentNode(a)); });
      if (mine) {
        var meta = h("span", { class: "meta" });
        if (m.status === "failed") {
          meta.appendChild(doc.createTextNode(t("not_sent") + " · "));
          meta.appendChild(h("button", { type: "button", class: "link-btn", "data-retry": m.client_msg_id, text: t("resend"), onclick: function () { resend(m.client_msg_id); } }));
        } else if (m.local) meta.textContent = t("sending");
        else meta.textContent = (m.read ? t("read") : t("sent")) + (m.created_at ? " · " + fmtTime(m.created_at) : "");
        body.appendChild(meta);
      } else if (sender.type !== "system" && m.created_at) {
        body.appendChild(h("span", { class: "meta", text: fmtTime(m.created_at) }));
      }
      list.appendChild(body);
    });
    renderRating();
    if (opts.prepend) list.scrollTop = prevTop + (list.scrollHeight - prevH);
    else if (opts.forceBottom || wasBottom) scrollToBottom();
    else if (opts.newIncoming && els.jump) els.jump.hidden = false;
  }

  function attachmentNode(a) {
    var url = a.url || a.preview;
    if (/^image\//.test(a.content_type || "") && url) {
      return h("a", { class: "att", href: a.url || "#", "data-cv-link": "attachment", "aria-label": t("image") + ": " + a.file_name }, [h("img", { src: url, alt: a.file_name || t("image"), loading: "lazy" })]);
    }
    return h("a", { class: "att file", href: url || "#", "data-cv-link": "attachment", text: "📎 " + (a.file_name || t("attachment")) });
  }

  /* satisfaction rating: offered once after the team closes the conversation (same rules as the widget) */
  function closedMarker() {
    var cm = state.room && state.room.closed_marker;
    if (!cm || state.room.status === "open") return null;
    var list = sorted();
    for (var i = list.length - 1; i >= 0; i--) {
      var m = list[i];
      if (m.deleted || (m.sender && m.sender.type === "system")) continue;
      if (m.local || m.seq == null || m.seq > cm.seq) return null;
      break;
    }
    return cm.id;
  }
  function renderRating() {
    var marker = state.room && closedMarker();
    if (!marker) return;
    var key = keyPrefix + "rated_" + state.room.id + "_" + marker;
    if (store.getItem(key)) { els.list.appendChild(h("div", { class: "m sys", text: t("thanks_feedback") })); return; }
    var box = h("div", { class: "rate", role: "group", "aria-label": t("rate_prompt") });
    box.appendChild(h("span", { text: t("rate_prompt") }));
    [1, 2, 3, 4, 5].forEach(function (n) {
      box.appendChild(h("button", { type: "button", "aria-label": t("rate_score", { n: n }), "data-score": String(n), text: String(n), onclick: function () {
        store.setItem(key, String(n));
        api("/public/rooms/" + state.room.id + "/csat", { method: "POST", body: { score: n } }).catch(function () {}).then(function () { renderMessages(); });
      } }));
    });
    els.list.appendChild(box);
  }

  function updateBanner() {
    if (!els.banner) return;
    var text = "";
    if (!state.online) text = t("offline");
    else if (state.session && state.room && !state.connected) text = t("reconnecting");
    els.banner.textContent = text;
    els.banner.hidden = !text;
    els.banner.className = "status" + (state.online ? " neutral" : "");
  }
  function renderTyping(name) { if (els.typing) els.typing.textContent = name ? t("typing", { name: name }) : ""; }

  function setUnread(n) {
    if (n === state.unread) return;
    state.unread = n;
    emit("unread_count_changed", { count: n });
  }

  /* ---------- views ---------- */
  function mountShell() {
    var app = doc.getElementById("app");
    app.textContent = "";
    app.removeAttribute("aria-busy");
    els.app = app;
    els.head = h("header", { class: "head" });
    els.body = h("main", { class: "msgs-wrap" });
    app.appendChild(els.head);
    els.banner = h("div", { class: "status", role: "status", hidden: true });
    app.appendChild(els.banner);
    app.appendChild(els.body);
    renderHeader();
  }

  function clearBody() { els.body.textContent = ""; els.list = null; els.input = null; els.typing = null; els.jump = null; els.compose = null; }

  function showChat() {
    state.view = "chat";
    clearBody();
    els.list = h("div", { class: "msgs", role: "log", "aria-live": "polite", "aria-relevant": "additions text", "aria-label": t("conversation"), tabindex: "-1" });
    els.jump = h("button", { type: "button", class: "jump", hidden: true, text: t("new_messages"), onclick: scrollToBottom });
    var wrap = h("div", { class: "msgs-wrap", style: null }, [els.list, els.jump]);
    els.typing = h("div", { class: "typing", "aria-live": "polite" });
    els.chips = h("div", { class: "chips", hidden: true });
    els.file = h("input", { type: "file", accept: "image/*,application/pdf", multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
    els.file.addEventListener("change", function () { addFiles(els.file.files); els.file.value = ""; });
    els.input = h("textarea", { rows: "1", placeholder: t("message_placeholder"), "aria-label": t("message_label"), maxlength: "4000", enterkeyhint: "send", autocomplete: "off" });
    els.input.addEventListener("keydown", function (e) {
      var coarse = global.matchMedia && global.matchMedia("(pointer: coarse)").matches;
      if (e.key === "Enter" && !e.shiftKey && !coarse) { e.preventDefault(); submit(); }
    });
    els.input.addEventListener("input", function () { sendTyping(); autosize(); syncSend(); });
    els.input.addEventListener("focus", function () { setTimeout(function () { global.scrollTo(0, 0); if (isNearBottom()) scrollToBottom(); }, 250); });
    els.sendBtn = h("button", { type: "button", class: "icon-btn send", "aria-label": t("send"), onclick: submit }, [icon("send", 20)]);
    els.emojiPop = null;
    els.compose = h("div", { class: "compose" }, [
      h("button", { type: "button", class: "icon-btn", "aria-label": t("attach"), onclick: function () { emit("attachment_requested", { kinds: ["image", "pdf"] }); els.file.click(); } }, [icon("clip", 22)]),
      h("button", { type: "button", class: "icon-btn", "aria-label": t("emoji"), "aria-expanded": "false", "data-emoji-toggle": "1", onclick: toggleEmoji }, [icon("smile", 22)]),
      els.input,
      els.sendBtn,
    ]);
    els.body.appendChild(wrap);
    els.body.appendChild(els.typing);
    els.body.appendChild(els.chips);
    els.body.appendChild(els.file);
    els.body.appendChild(els.compose);
    els.body.style.display = "flex"; els.body.style.flexDirection = "column";
    wrap.style.flex = "1"; wrap.style.minHeight = "0"; wrap.style.display = "flex"; wrap.style.flexDirection = "column";
    els.list.addEventListener("scroll", onListScroll, { passive: true });
    els.list.addEventListener("click", onListClick);
    if (els.list.addEventListener) {
      var startY = null;
      els.list.addEventListener("touchstart", function (e) { startY = els.list.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
      els.list.addEventListener("touchmove", function (e) { if (startY !== null && e.touches[0].clientY - startY > 70) { startY = null; loadOlder(); } }, { passive: true });
    }
    syncSend();
    updateBanner();
    renderMessages({ forceBottom: true });
    renderChips();
  }

  function autosize() { els.input.style.height = "auto"; els.input.style.height = Math.min(els.input.scrollHeight, 132) + "px"; }
  function syncSend() {
    if (!els.sendBtn) return;
    var uploading = state.attachments.some(function (a) { return a.status === "uploading"; });
    var ready = state.attachments.some(function (a) { return a.status === "ready"; });
    els.sendBtn.disabled = uploading || !((els.input.value || "").trim() || ready);
  }

  function toggleEmoji() {
    if (els.emojiPop) { closeEmoji(); return; }
    els.emojiPop = h("div", { class: "emoji-pop", role: "group", "aria-label": t("emoji_picker") }, EMOJI.map(function (e) {
      return h("button", { type: "button", "aria-label": e, text: e, onclick: function () {
        var inp = els.input, s = inp.selectionStart == null ? inp.value.length : inp.selectionStart, en = inp.selectionEnd == null ? s : inp.selectionEnd;
        inp.value = inp.value.slice(0, s) + e + inp.value.slice(en);
        inp.selectionStart = inp.selectionEnd = s + e.length;
        autosize(); syncSend(); inp.focus();
      } });
    }));
    els.compose.appendChild(els.emojiPop);
    els.compose.querySelector("[data-emoji-toggle]").setAttribute("aria-expanded", "true");
  }
  function closeEmoji() {
    if (!els.emojiPop) return false;
    els.emojiPop.remove(); els.emojiPop = null;
    var b = els.compose && els.compose.querySelector("[data-emoji-toggle]");
    if (b) b.setAttribute("aria-expanded", "false");
    return true;
  }

  function showForm() {
    state.view = "form";
    clearBody();
    var w = state.config.widget;
    var need = w.required_info.slice();
    if (w.chat_type === "sms" && need.indexOf("phone") < 0) need.push("phone");
    var labels = { name: t("name"), email: t("email"), phone: t("phone") };
    var inputs = {};
    var pre = state.identity || {};
    var form = h("form", { class: "form", "aria-label": labels.name, novalidate: false });
    form.appendChild(h("p", { class: "hint", text: w.chat_type === "sms" ? t("form_hint_sms") : t("form_hint") }));
    ["name", "email", "phone"].forEach(function (k) {
      var req = need.indexOf(k) >= 0;
      var input = h("input", { type: k === "email" ? "email" : k === "phone" ? "tel" : "text", name: k, required: req, autocomplete: k === "phone" ? "tel" : k, inputmode: k === "phone" ? "tel" : k === "email" ? "email" : null, value: pre[k] || null });
      inputs[k] = input;
      form.appendChild(h("label", null, [labels[k] + (req ? "" : " (" + t("optional") + ")"), input]));
    });
    form.appendChild(h("div", { class: "err", role: "alert", text: state.error }));
    form.appendChild(h("button", { type: "submit", class: "btn", text: t("start_chat") }));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      state.error = "";
      state.identity = Object.assign({}, state.identity || {}, { name: inputs.name.value.trim() || undefined, email: inputs.email.value.trim() || undefined, phone: inputs.phone.value.trim() || undefined });
      startSession().catch(function (ex) { state.error = ex.message; showForm(); });
    });
    els.body.appendChild(form);
    var first = form.querySelector("input");
    if (first && first.focus) first.focus();
  }

  function showOtp() {
    state.view = "otp";
    clearBody();
    var form = h("form", { class: "form" });
    form.appendChild(h("p", { class: "hint", text: state.info || t("otp_hint") }));
    var code = h("input", { type: "text", inputmode: "numeric", pattern: "[0-9]{5}", maxlength: "5", name: "code", autocomplete: "one-time-code", "aria-label": t("otp_code_aria") });
    form.appendChild(h("label", null, [t("otp_code"), code]));
    form.appendChild(h("div", { class: "err", role: "alert", text: state.error }));
    form.appendChild(h("button", { type: "submit", class: "btn", text: t("otp_verify") }));
    form.appendChild(h("button", { type: "button", class: "btn secondary", "data-send-code": "1", text: t("otp_send"), onclick: requestOtp }));
    form.addEventListener("submit", function (e) { e.preventDefault(); verifyOtp(code.value.trim()); });
    els.body.appendChild(form);
  }

  function showNotice(title, text, actions, fatal) {
    state.view = "notice";
    clearBody();
    var box = h("div", { class: "form", role: "alert" }, [h("h2", { text: title }), h("p", { class: "hint", text: text })]);
    (actions || []).forEach(function (a) { box.appendChild(h("button", { type: "button", class: "btn" + (a.secondary ? " secondary" : ""), text: a.label, onclick: a.run })); });
    els.body.appendChild(box);
    if (fatal) emit("error", { code: fatal.code, message: fatal.message.slice(0, 300), fatal: true });
  }

  /* ---------- session and room ---------- */
  function identityKey() { var i = state.identity || {}; return (i.external_id || "") + "|" + (i.email || "").toLowerCase() + "|" + (i.identity_hash ? "s" : "u"); }
  function saveSession(s) {
    state.session = s;
    store.setItem(keyPrefix + "session", JSON.stringify(s));
    store.setItem(keyPrefix + "identity", identityKey());
  }
  function forgetSession() {
    state.session = null; state.room = null; state.messages = []; state.socket && state.socket.disconnect(); state.socket = null; state.connected = false;
    store.removeItem(keyPrefix + "session"); store.removeItem(keyPrefix + "identity"); store.removeItem(keyPrefix + "queue");
    state.lastReadId = null; state.moreOlder = false; state.roomStatus = null; state.closedAnnounced = false; state.attrsSent = false;
    setUnread(0);
  }

  function needsForm() {
    var w = state.config.widget, i = state.identity || {};
    if (i.identity_hash) return false;
    var need = w.required_info.slice();
    if (w.chat_type === "sms" && need.indexOf("phone") < 0) need.push("phone");
    return need.some(function (k) { return !i[k]; });
  }

  function startSession() {
    var i = state.identity || {};
    var body = {};
    ["name", "email", "phone", "external_id", "identity_hash"].forEach(function (k) { if (i[k]) body[k] = i[k]; });
    return api("/public/sessions", { method: "POST", body: body, noSession: true }).then(function (s) {
      saveSession(s);
      return ensureRoom(!!s.requires_verification);
    }, function (e) {
      if (e.code === "IDENTITY_HASH_INVALID" || e.code === "IDENTITY_CONFLICT" || e.code === "IDENTITY_NOT_CONFIGURED") {
        emit("auth_required", { reason: e.code === "IDENTITY_CONFLICT" ? "conflict" : "identity_invalid" });
        showNotice(t("identity_failed_title"), t("identity_failed_text"), [{
          label: t("continue_guest"),
          run: function () { state.identity = null; startSession().catch(fatalFrom); },
        }]);
        return null;
      }
      throw e;
    });
  }

  function ensureRoom(requiresVerification) {
    return api("/public/rooms").then(function (r) {
      if (r.data.length) return { room: r.data[0], created: false };
      return api("/public/rooms", { method: "POST", body: {} }).then(function (x) { return { room: x.room, created: !!x.created }; });
    }).catch(function (e) {
      if (e.code === "VERIFICATION_REQUIRED" || requiresVerification) { state.info = ""; emit("auth_required", { reason: "verification_required" }); showOtp(); return null; }
      throw e;
    }).then(function (res) {
      if (!res) return null;
      state.room = res.room;
      if (res.created) emit("conversation_started", { room_id: res.room.id });
      setUnread(res.room.unread_count || 0);
      return loadMessages(true).then(function () {
        showChat();
        connectSocket();
        flushQueue();
        pushAttributes();
        scheduleRead();
        if (global.__cvTestHook) global.__cvTestHook("room");
      });
    });
  }

  function requestOtp() {
    state.error = "";
    api("/public/otp/send", { method: "POST", body: {} }).then(function (r) {
      state.info = t("otp_sent", { channel: r.channel });
      showOtp();
    }).catch(function (e) { state.error = e.message; showOtp(); });
  }
  function verifyOtp(code) {
    state.error = "";
    return api("/public/otp/verify", { method: "POST", body: { code: code } }).then(function () {
      saveSession(Object.assign({}, state.session, { verified: true }));
      return ensureRoom(false);
    }).catch(function (e) { state.error = e.message; showOtp(); });
  }

  function applyRoomState(room) {
    if (!room || !state.room || room.id !== state.room.id) return;
    state.room.status = room.status;
    state.room.closed_marker = room.closed_marker || null;
    if (room.status === "closed" && state.roomStatus && state.roomStatus !== "closed") emit("conversation_closed", { room_id: room.id });
    state.roomStatus = room.status;
  }

  function loadMessages(initial) {
    return apiRetry("/public/rooms/" + state.room.id + "/messages?limit=" + PAGE).then(function (r) {
      state.roomStatus = initial ? r.room.status : state.roomStatus;
      applyRoomState(r.room);
      if (initial) state.moreOlder = !!r.pagination.has_more_before;
      mergeServerPage(r.data, !!initial);
    });
  }
  function loadOlder() {
    if (state.loadingOlder || !state.moreOlder || !state.room) return;
    var before = oldestServerId();
    if (!before) return;
    state.loadingOlder = true;
    renderMessages({ prepend: true });
    api("/public/rooms/" + state.room.id + "/messages?limit=" + PAGE + "&before=" + encodeURIComponent(before)).then(function (r) {
      state.moreOlder = !!r.pagination.has_more_before;
      mergeServerPage(r.data, false);
    }).catch(function () {}).then(function () { state.loadingOlder = false; renderMessages({ prepend: true }); });
  }
  function onListScroll() {
    if (els.list.scrollTop < 24 && state.moreOlder && !state.loadingOlder) loadOlder();
    if (isNearBottom()) { if (els.jump) els.jump.hidden = true; scheduleRead(); }
  }
  function onListClick(e) {
    var a = e.target.closest ? e.target.closest("a[data-cv-link]") : null;
    if (!a) return;
    e.preventDefault();
    openLink(a.getAttribute("href"), a.getAttribute("data-cv-link"));
  }
  function openLink(url, source) {
    var strict = Bridge.validateLink(url, {});
    var lax = strict.ok ? strict : Bridge.validateLink(url, { own: global.location.origin });
    if (!lax.ok) return;
    var fallback = function () { try { global.open(lax.url, "_blank", "noopener,noreferrer"); } catch (e) { /* the host decides */ } };
    if (bridge.transport.name === "none" || !strict.ok) return fallback();
    bridge.emitAwait("link_clicked", { url: strict.url, source: source === "attachment" || source === "payment" ? source : "message" }, 800).then(function (ack) {
      if (!(ack && ack.ok && ack.handled)) fallback();
    });
  }

  /* ---------- sockets ---------- */
  function connectSocket() {
    if (state.socket || !state.session || !state.room) return;
    var io = global.io;
    if (!io) { startPolling(); return; }
    var socket = io("/ws/" + state.session.workspace_id, { auth: { session: state.session.session_token, deviceId: deviceId }, transports: ["websocket", "polling"], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 30000, randomizationFactor: 0.8 });
    state.socket = socket;
    socket.on("connect", function () {
      state.connected = true; stopPolling(); updateBanner();
      loadMessages(false).then(function () { renderMessages(); flushQueue(); }).catch(function () {});
    });
    socket.on("disconnect", function (reason) {
      state.connected = false; updateBanner();
      if (reason === "io server disconnect") {
        var wait = state.drainWait != null ? state.drainWait : 500 + Math.random() * 4500;
        state.drainWait = null;
        setTimeout(function () { if (state.socket === socket) socket.connect(); }, wait);
      }
    });
    socket.on("server:resync", function () { loadMessages(false).then(function () { renderMessages(); }).catch(function () {}); });
    socket.on("server:draining", function (p) { state.drainWait = Math.max(500, (p && p.reconnect_in_ms) || 0) + Math.random() * 1000; });
    socket.on("connect_error", function (err) {
      state.connected = false; updateBanner(); startPolling();
      if (err && /SESSION_EXPIRED|INVALID_SESSION|ORIGIN_NOT_ALLOWED/.test(String(err.message))) sessionLost();
    });
    socket.on("message:new", function (p) { onIncoming(p.message); });
    socket.on("room:updated", function (p) { applyRoomState(p && p.room); renderMessages(); });
    socket.on("message:updated", function (p) { upsert(p.message); renderMessages(); });
    socket.on("message:deleted", function (p) { state.messages = state.messages.filter(function (m) { return m.id !== p.message_id; }); renderMessages(); });
    socket.on("message:receipt", function (p) {
      if (!p.reader || p.reader.type !== "agent") return;
      state.messages.forEach(function (m) { if (m.seq != null && m.seq <= p.up_to_seq && m.sender && m.sender.type === "contact") m.read = true; });
      renderMessages();
    });
    socket.on("typing", function (p) {
      if (!p.typing || (p.who && p.who.type !== "agent")) return renderTyping("");
      renderTyping((p.who && p.who.name) || t("someone"));
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(function () { renderTyping(""); }, 4000);
    });
    socket.on("session:verified", function () { loadMessages(false).then(function () { renderMessages(); }); });
  }
  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(function () { if (state.room && state.session && state.visible) loadMessages(false).then(function () { renderMessages(); }).catch(function () {}); }, 5000);
  }
  function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }
  function sessionLost() {
    emit("auth_required", { reason: "session_expired" });
    forgetSession();
    startFlow();
  }

  function onIncoming(m) {
    var added = upsert(m);
    var near = isNearBottom();
    renderMessages({ newIncoming: !near && state.visible });
    var fromTeam = m.sender && (m.sender.type === "agent" || m.sender.type === "bot");
    if (added && fromTeam) {
      emit("message_received", { message_id: m.id, sender_type: m.sender.type, preview: String(m.content_text || "").slice(0, 140), has_attachments: !!(m.attachments && m.attachments.length), in_foreground: state.visible });
      if (!state.visible || !near) setUnread(state.unread + 1);
      scheduleRead();
    }
  }

  /* ---------- sending, queue, uploads ---------- */
  function readQueue() { try { return JSON.parse(store.getItem(keyPrefix + "queue") || "[]"); } catch (e) { return []; } }
  function writeQueue() {
    var items = Object.keys(state.pending).filter(function (k) { return !state.pending[k].attachments; }).map(function (k) { return { qid: k, content: state.pending[k].content }; });
    if (items.length) store.setItem(keyPrefix + "queue", JSON.stringify(items.slice(-20))); else store.removeItem(keyPrefix + "queue");
  }
  function flushQueue() {
    if (!state.room) return;
    readQueue().forEach(function (it) {
      if (!state.pending[it.qid]) {
        state.pending[it.qid] = { content: it.content, tries: 0 };
        state.messages.push({ local: true, client_msg_id: it.qid, content_text: it.content, sender: { type: "contact" }, status: "failed", seq: null });
      }
    });
    Object.keys(state.pending).forEach(function (qid) {
      var m = state.messages.filter(function (x) { return x.client_msg_id === qid && x.local; })[0];
      if (m && m.status === "failed" && state.online) resend(qid);
    });
    renderMessages();
  }

  function submit() {
    var text = (els.input.value || "").trim();
    var ready = state.attachments.filter(function (a) { return a.status === "ready"; });
    if (!text && !ready.length) return;
    if (state.attachments.some(function (a) { return a.status === "uploading"; })) return;
    els.input.value = ""; autosize();
    closeEmoji();
    var atts = ready.slice();
    state.attachments = state.attachments.filter(function (a) { return a.status === "error"; });
    renderChips(); syncSend();
    return send(text, atts);
  }

  function send(text, atts) {
    return ensureRoomForSend().then(function () {
      var qid = uuid();
      atts = atts || [];
      state.pending[qid] = { content: text, tries: 0, attachments: atts.length ? atts.map(function (a) { return a.att.id; }) : null };
      state.messages.push({ local: true, client_msg_id: qid, content_text: text, sender: { type: "contact" }, status: "sending", seq: null, localAttachments: atts.map(function (a) { return { file_name: a.name, content_type: a.type, preview: a.preview }; }) });
      writeQueue();
      renderMessages({ forceBottom: true });
      return transmit(qid);
    });
  }
  function ensureRoomForSend() {
    if (state.room) return Promise.resolve();
    return startFlow();
  }

  function transmit(qid) {
    var p = state.pending[qid];
    if (!p) return Promise.resolve();
    p.tries++;
    var done = function (message) { upsert(Object.assign({}, message, { client_msg_id: qid })); delete state.pending[qid]; writeQueue(); renderMessages({ forceBottom: true }); return message; };
    var fail = function () { mark(qid, "failed"); };
    var rest = function () {
      var body = { content: p.content, client_msg_id: qid };
      if (p.attachments) body.attachment_ids = p.attachments;
      return api("/public/rooms/" + state.room.id + "/messages", { method: "POST", body: body }).then(done).catch(function (e) {
        if (e.status === 401) sessionLost();
        fail();
      });
    };
    if (!p.attachments && state.socket && state.connected) {
      return new Promise(function (resolve) {
        var timer = setTimeout(function () { rest().then(resolve); }, 8000);
        state.socket.emit("message:send", { room_id: state.room.id, kind: "text", source: "dm", content: p.content, client_msg_id: qid }, function (ack) {
          clearTimeout(timer);
          if (ack && ack.ok) { done(ack.message); resolve(ack.message); } else rest().then(resolve);
        });
      });
    }
    return rest();
  }
  function mark(qid, status) {
    state.messages.forEach(function (m) { if (m.client_msg_id === qid && m.local) m.status = status; });
    renderMessages();
  }
  function resend(qid) { mark(qid, "sending"); return transmit(qid); }

  var typingAt = 0;
  function sendTyping() {
    if (!state.socket || !state.connected || !state.room || Date.now() - typingAt < 2000) return;
    typingAt = Date.now();
    state.socket.emit("typing", { room_id: state.room.id, typing: true });
  }

  // uploads
  function addFiles(fileList) {
    ensureRoomForSend().then(function () {
      Array.prototype.slice.call(fileList || []).slice(0, 4).forEach(function (file) {
        var item = { id: uuid(), name: file.name || t("attachment"), type: file.type || "", status: "uploading", preview: null, att: null, file: file };
        if (!/^(image\/|application\/pdf$)/.test(file.type || "")) { item.status = "error"; item.error = t("file_unsupported"); }
        else if (file.size > MAX_UPLOAD_BYTES) { item.status = "error"; item.error = t("file_too_large", { name: item.name }); }
        if (/^image\//.test(file.type || "") && global.URL && global.URL.createObjectURL) item.preview = global.URL.createObjectURL(file);
        state.attachments.push(item);
        if (item.status === "uploading") upload(item);
      });
      renderChips(); syncSend();
    });
  }
  function upload(item) {
    var form = new global.FormData();
    form.append("file", item.file, item.name);
    api("/public/attachments", { method: "POST", form: form }).then(function (att) { item.att = att; item.status = "ready"; }).catch(function (e) {
      item.status = "error"; item.error = e.code === "FILE_TOO_LARGE" ? t("file_too_large", { name: item.name }) : e.code === "UNSUPPORTED_FILE_TYPE" || e.code === "FILE_TYPE_MISMATCH" ? t("file_unsupported") : t("upload_failed", { name: item.name });
    }).then(function () { renderChips(); syncSend(); });
  }
  function renderChips() {
    if (!els.chips) return;
    els.chips.textContent = "";
    els.chips.hidden = !state.attachments.length;
    state.attachments.forEach(function (a) {
      var chip = h("div", { class: "chip" + (a.status === "error" ? " err" : ""), role: "group", "aria-label": a.name }, [
        a.preview ? h("img", { src: a.preview, alt: "" }) : null,
        h("span", { class: "nm", text: a.status === "uploading" ? t("uploading") : a.status === "error" ? a.error : a.name }),
        h("button", { type: "button", class: "icon-btn", "aria-label": t("remove_attachment", { name: a.name }), onclick: function () { state.attachments = state.attachments.filter(function (x) { return x !== a; }); renderChips(); syncSend(); } }, [icon("x", 16)]),
      ]);
      els.chips.appendChild(chip);
    });
  }

  function pushAttributes() {
    if (!state.session || state.attrsSent || !Object.keys(state.attrs).length) return;
    state.attrsSent = true;
    api("/public/session/attributes", { method: "POST", body: { attributes: state.attrs } }).catch(function () { state.attrsSent = false; });
  }

  /* ---------- read receipts ---------- */
  var readTimer = null;
  function scheduleRead() {
    if (!state.room || !state.visible || state.view !== "chat" || !isNearBottom()) return;
    clearTimeout(readTimer);
    readTimer = setTimeout(function () {
      setUnread(0);
      var last = sorted().filter(function (m) { return m.id && !m.local && m.sender && m.sender.type !== "contact" && m.sender.type !== "system"; }).pop();
      if (!last || last.id === state.lastReadId) return;
      state.lastReadId = last.id;
      if (state.socket && state.connected) state.socket.emit("message:read", { room_id: state.room.id, message_id: last.id }, function () {});
      else api("/public/rooms/" + state.room.id + "/read", { method: "POST", body: { message_id: last.id } }).catch(function () {});
    }, 300);
  }

  /* ---------- flow ---------- */
  function fatalFrom(e) {
    if (e && (e.status === 401 || e.status === 403) && !state.session) {
      showNotice(t("unavailable_title"), t("unavailable_text"), [], { code: e.code || "UNAVAILABLE", message: e.message });
      return;
    }
    showNotice(t("could_not_start"), (e && e.message) || "", [{ label: t("retry"), run: function () { startFlow().catch(fatalFrom); } }], { code: (e && e.code) || "START_FAILED", message: (e && e.message) || "start failed" });
  }

  /** Restore the stored session or begin a new one (form first when the workspace requires details the host did not give). */
  function startFlow() {
    state.started = true;
    var storedKey = store.getItem(keyPrefix + "identity");
    var mismatch = state.session && state.identity && storedKey !== identityKey();
    var p = Promise.resolve();
    if (mismatch) { var old = state.session; p = api("/public/session", { method: "DELETE" }).catch(function () {}).then(function () { void old; forgetSession(); }); }
    return p.then(function () {
      if (state.session) {
        return ensureRoom(false).catch(function (e) {
          if (e.status === 401) { forgetSession(); return startFlow(); }
          throw e;
        });
      }
      if (needsForm()) { showForm(); return null; }
      return startSession();
    });
  }

  function resetAll() {
    var done = state.session ? api("/public/session", { method: "DELETE" }).catch(function () {}) : Promise.resolve();
    return done.then(function () {
      forgetSession();
      state.identity = null; state.attrs = {};
      deviceId = "d" + uuid().replace(/-/g, "");
      store.setItem(keyPrefix + "device", deviceId);
      state.attachments = [];
      showBoot();
      return startFlow().catch(fatalFrom);
    });
  }
  function showBoot() {
    clearBody();
    els.body.appendChild(h("div", { class: "boot", role: "status" }, [h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { text: t("loading") })]));
  }

  /* ---------- host commands ---------- */
  var commands = {
    identify: function (p) {
      state.identity = {};
      ["name", "email", "phone", "external_id", "identity_hash"].forEach(function (k) { if (p[k]) state.identity[k] = p[k]; });
      if (!state.started) return { applied: "on_start" };
      if (state.session && store.getItem(keyPrefix + "identity") === identityKey()) return { applied: "unchanged" };
      showBoot();
      startFlow().catch(fatalFrom);
      return { applied: "restarting" };
    },
    setLanguage: function (p) {
      state.locale = p.locale;
      state.strings = {};
      var known = I18n.en;
      if (p.strings) Object.keys(p.strings).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(known, k)) state.strings[k] = p.strings[k]; });
      applyLocale();
      rerender();
    },
    setTheme: function (p) {
      if (p.theme) setTheme(p.theme);
      if (p.primary_color) applyColors(p.primary_color, p.text_color);
      return { theme: effectiveTheme() };
    },
    setCustomAttributes: function (p) {
      Object.keys(p.attributes).forEach(function (k) { state.attrs[k] = p.attributes[k]; });
      state.attrsSent = false;
      pushAttributes();
    },
    open: function () { if (els.input) { els.input.focus(); scrollToBottom(); } },
    close: function () { closeEmoji(); if (els.input) els.input.blur(); },
    back: function () {
      if (closeEmoji()) return { handled: true };
      if (state.view === "otp" || state.view === "form") return { handled: false };
      return { handled: false };
    },
    sendMessage: function (p) {
      if (!p.send) {
        if (!els.input) throw { code: "NOT_READY", message: "The conversation is not open yet" };
        els.input.value = p.text; autosize(); syncSend(); els.input.focus();
        return { sent: false };
      }
      return send(p.text, []).then(function () {
        var last = state.messages.filter(function (m) { return m.sender && m.sender.type === "contact"; }).pop();
        return { sent: true, message_id: last && last.id ? last.id : undefined };
      });
    },
    reset: function () { return resetAll().then(function () { return {}; }); },
    restoreSession: function (p) {
      if (state.session) return { applied: false };
      deviceId = p.device_id;
      store.setItem(keyPrefix + "device", deviceId);
      return { applied: true };
    },
  };
  Object.assign(handlers, commands);

  function rerender() {
    if (!state.config) return;
    renderHeader();
    if (state.view === "chat") showChat();
    else if (state.view === "form") showForm();
    else if (state.view === "otp") showOtp();
  }

  /* ---------- visibility, network, viewport ---------- */
  doc.addEventListener("visibilitychange", function () {
    state.visible = !doc.hidden;
    if (state.visible && state.room) {
      loadMessages(false).then(function () { renderMessages(); scheduleRead(); }).catch(function () {});
      if (state.socket && !state.connected) state.socket.connect();
      flushQueue();
    }
  });
  global.addEventListener("pageshow", function (e) { if (e.persisted && state.room) { state.visible = true; loadMessages(false).then(function () { renderMessages(); }).catch(function () {}); } });
  global.addEventListener("online", function () { state.online = true; updateBanner(); if (state.socket && !state.connected) state.socket.connect(); flushQueue(); });
  global.addEventListener("offline", function () { state.online = false; updateBanner(); });
  if (global.visualViewport) {
    var vv = global.visualViewport;
    var syncViewport = function () {
      // pinch-zoom changes the visual viewport too; only follow it when the page is at its normal scale (the on-screen keyboard)
      if (vv.scale && vv.scale > 1.01) return;
      doc.documentElement.style.setProperty("--vvh", Math.round(vv.height) + "px");
      if (vv.offsetTop) global.scrollTo(0, 0);
      if (els.input && doc.activeElement === els.input && isNearBottom()) scrollToBottom();
    };
    vv.addEventListener("resize", syncViewport);
    vv.addEventListener("scroll", syncViewport);
    syncViewport();
  }

  /* ---------- boot ---------- */
  function boot() {
    if (P.safe_area) doc.documentElement.setAttribute("data-safe-area", "1");
    if (P.theme) setTheme(P.theme);
    applyLocale();
    var bootText = doc.getElementById("boot-text");
    if (bootText) bootText.textContent = t("loading");
    if (!P.token) { fail("NO_TOKEN"); return; }

    apiRetry("/public/widget/config", { noSession: true }).then(function (cfg) {
      state.config = cfg;
      applyColors(P.primary_color && /^#[0-9a-fA-F]{6}$/.test(P.primary_color) ? P.primary_color : cfg.widget.primary_color, P.primary_color ? undefined : cfg.widget.text_color);
      applyLocale();
      mountShell();
      emit("ready", { protocol: Bridge.PROTOCOL_VERSION, page_version: VERSION, device_id: deviceId, locale: state.locale, theme: effectiveTheme(), features: ["attachments", "emoji", "csat", "otp", "prechat", "identity", "offline_queue", "rtl", "pagination"], unread_count: state.unread });
      var native = bridge.transport.name !== "none" && bridge.transport.name !== "iframe";
      // give a native host a moment to answer `ready` with identify / restoreSession before a first session is created
      var delay = native && !state.session ? 250 : 0;
      showBoot();
      setTimeout(function () { if (!state.started) startFlow().catch(fatalFrom); }, delay);
    }).catch(function (e) { fail(e.code || "UNAVAILABLE", e); });
  }
  function fail(code, e) {
    var app = doc.getElementById("app");
    app.textContent = "";
    app.removeAttribute("aria-busy");
    app.appendChild(h("div", { class: "unavailable", role: "alert" }, [h("h1", { text: t("unavailable_title") }), h("p", { text: t("unavailable_text") })]));
    emit("error", { code: String(code).slice(0, 64), message: String((e && e.message) || "Chat is not available").slice(0, 300), fatal: true });
  }

  if (P.debug) global.__cv = { state: state, bridge: bridge, params: P };
  boot();
})(window);
