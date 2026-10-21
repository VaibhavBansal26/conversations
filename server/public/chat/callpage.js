/*!
 * The page behind a call link (/call/<token>, docs/CALLS.md "Call links", ADR 0037). Needs no login: the address is the credential.
 *
 * What it does, in order: reads the token from the address and removes it from the address bar at once (history.replaceState) so it cannot be copied
 * from the URL, bookmarked or leak through a screenshot of the tab; asks the server what the link is for; shows who is calling and, for the AI
 * assistant, that it is an AI; asks only for an optional name (the browser asks for the microphone/camera when the call starts); redeems the link
 * for a session that can only take part in this call; then runs the same call code as the widget (ConversationsAiCall or ConversationsCalls).
 * Every failure (unknown, expired, used, revoked, wrong device) shows the same single message.
 *
 * The token is only kept in this closure: never in storage, never in a log, never in a request URL (it travels in a POST body).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ConversationsCallPage = api;
  if (typeof document !== "undefined" && root.__CALLPAGE_AUTOSTART !== false && document.getElementById && document.getElementById("cpage")) {
    api.start({ win: root, doc: document });
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** The token in `/call/<token>`, or "" (the address is `/call/` after it has been read once). */
  function tokenFromPath(path) {
    var m = /^\/call\/([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\/?$/.exec(String(path || ""));
    return m ? m[1] : "";
  }

  function randomDevice(win) {
    var a = new Uint8Array(16);
    (win.crypto || {}).getRandomValues ? win.crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); });
    return "cl_" + Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function start(o) {
    var win = o.win, doc = o.doc;
    var I18n = o.I18n || win.ConversationsI18n;
    var t = I18n.translator((win.navigator && (win.navigator.language || (win.navigator.languages || [])[0])) || "en");
    var root = doc.getElementById("cpage");
    var fetchFn = o.fetch || win.fetch.bind(win);
    var token = tokenFromPath(win.location.pathname);
    // the address bar no longer holds the credential; a reload shows the generic message (the link cannot be reopened by accident)
    try { win.history.replaceState(null, "", "/call/"); } catch (e) { /* a sandboxed frame: nothing to strip */ }
    try { doc.title = t("call_page_title"); } catch (e) { /* ignore */ }
    var lang = (win.navigator && win.navigator.language) || "en";
    doc.documentElement.setAttribute("lang", lang.split("-")[0]);

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
    function show(nodes, busy) {
      root.textContent = "";
      root.setAttribute("aria-busy", busy ? "true" : "false");
      nodes.forEach(function (n) { root.appendChild(n); });
    }
    function gone() {
      token = "";
      show([h("div", { class: "cp-card", role: "alert" }, [h("h1", { text: t("call_page_title") }), h("p", { class: "cp-msg", "data-cp": "gone", text: t("call_page_gone") })])]);
    }
    function post(path, body) {
      return fetchFn(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error("http_" + r.status); return j; });
      });
    }

    if (!token) { gone(); return { gone: true }; }

    show([h("div", { class: "boot", role: "status" }, [h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { text: t("call_page_loading") })])], true);
    post("/public/call-links/preview", { token: token }).then(function (p) { consent(p); }, gone);

    function consent(p) {
      var isAi = p.mode === "ai" && p.ai;
      var video = p.kind === "video";
      var avatar = isAi && p.ai.avatar_url && /^\/avatars\/[A-Za-z0-9._\/-]+$/.test(p.ai.avatar_url) ? p.ai.avatar_url : "";
      var nameInput = h("input", { type: "text", id: "cp-name", maxlength: "60", autocomplete: "name", "data-cp": "name" });
      var join = h("button", { type: "button", class: "btn", "data-cp": "join", text: t("call_page_join") });
      var kids = [];
      if (avatar) kids.push(h("img", { class: "cp-av", src: avatar, alt: p.ai.avatar_alt || "", referrerpolicy: "no-referrer" }));
      kids.push(h("h1", { text: isAi ? t("call_card_ai", { name: p.ai.name }) : t("call_card_team") }));
      if (isAi) {
        // the disclosure comes before anything else on the page: this is an AI, not a person
        kids.push(h("p", { class: "cp-ai", "data-cp": "disclosure" }, [h("span", { class: "tag", text: p.ai.label || t("ai_tag") }), " ", t("call_page_ai", { name: p.ai.name })]));
        if (video) kids.push(h("p", { class: "cp-note", text: t("call_page_ai_video") }));
        kids.push(h("p", { class: "cp-note", text: t("call_page_ai_note") }));
      } else kids.push(h("p", { class: "cp-msg", text: t("call_page_team", { workspace: p.workspace_name || "" }) }));
      kids.push(h("p", { class: "cp-note", text: video && !isAi ? t("call_page_perm_video") : t("call_page_perm_voice") }));
      kids.push(h("label", { for: "cp-name", text: t("call_page_name") }));
      kids.push(nameInput);
      kids.push(join);
      show([h("form", { class: "cp-card", onsubmit: function (e) { e.preventDefault(); } }, kids)]);
      join.addEventListener("click", function () {
        join.disabled = true;
        var device = randomDevice(win);
        post("/public/call-links/redeem", { token: token, device_id: device, name: nameInput.value.trim() || undefined }).then(function (s) { token = ""; run(s); }, gone);
      });
    }

    function run(s) {
      var io = o.io || win.io;
      var box = h("div", { class: "cp-stage" });
      show([box]);
      var socket = io("/ws/" + s.workspace_id, { auth: { session: s.session_token, deviceId: s.device_id }, transports: ["websocket", "polling"], reconnection: true });
      function finished() { show([h("div", { class: "cp-card", role: "status" }, [h("h1", { text: t("call_page_title") }), h("p", { class: "cp-msg", "data-cp": "done", text: t("call_page_done") })])]); try { socket.close(); } catch (e) { /* closed */ } }
      var emit = function () {};
      function over(call) { return call && (call.state === "ended" || call.state === "declined" || call.state === "missed" || call.state === "failed"); }
      socket.on("connect_error", function (err) { if (err && /SESSION_EXPIRED|INVALID_SESSION/.test(String(err.message))) gone(); });
      if (s.mode === "ai") {
        var cfg = s.ai_config || { enabled: true, voice: true, video: true };
        var ai = (o.AiCall || win.ConversationsAiCall).create({
          doc: doc, win: win, container: box, getSocket: function () { return socket; }, getRoomId: function () { return s.room_id; }, config: { ai: cfg }, emit: emit, t: function (k, v) { return t(k, v); },
          onFallback: function () { /* no speech here: the overlay explains it and the page offers nothing else to do */ },
        });
        ai.bind(socket);
        socket.on("call:state", function (p) { if (p && over(p.call) && p.call.transport === "ai") setTimeout(finished, 2500); });
        var begin = function () { ai.start(s.kind === "video" ? "video" : "voice"); };
        if (socket.connected) begin(); else socket.once("connect", begin);
      } else {
        var calls = (o.Calls || win.ConversationsCalls).create({
          doc: doc, win: win, container: box, getSocket: function () { return socket; }, getRoomId: function () { return s.room_id; }, config: { browser: { enabled: true, voice: true, video: true, screen_share: false } }, emit: emit, t: function (k, v) { return t(k, v); },
        });
        calls.bind(socket);
        var wait = h("div", { class: "cp-card cp-wait", role: "status" }, [h("span", { class: "spinner", "aria-hidden": "true" }), h("p", { class: "cp-msg", "data-cp": "waiting", text: t("call_page_waiting", { workspace: s.workspace_name || "" }) })]);
        box.appendChild(wait);
        socket.on("call:state", function (p) {
          if (!p || !p.call) return;
          // once the team rings, the incoming-call screen takes over from the waiting note
          if (p.call.state === "ringing" || p.call.state === "connecting" || p.call.state === "active") wait.hidden = true;
          if (over(p.call)) setTimeout(finished, 1500);
        });
      }
    }
    return { gone: false };
  }

  return { start: start, tokenFromPath: tokenFromPath };
});
