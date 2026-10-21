/*!
 * Conversations live-chat widget. Framework-free; renders in a Shadow DOM.
 *   <script src="https://YOUR-HOST/widget.js" data-token="cvt_..." async></script>
 * The in-app "Try it now" page loads it with data-preview="<signed flag>" instead of a token (see docs/WIDGET.md).
 * Talks to the same origin that served this file: GET /public/widget/config, POST /public/sessions, Socket.IO namespace /ws/<workspaceId>.
 */
(function (global) {
  "use strict";
  var VERSION = "1.0.0";
  var RESEND_AFTER_MS = 8000;
  var OPEN_STATE = { CHAT: "chat", FORM: "form", OTP: "otp" };

  function uuid() {
    var c = global.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    var s = "";
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, 8) + "-" + s.slice(8, 12) + "-4" + s.slice(13, 16) + "-a" + s.slice(17, 20) + "-" + s.slice(20, 32);
  }

  function safeStorage(win) {
    try {
      var s = win.localStorage;
      s.setItem("__cv_probe", "1");
      s.removeItem("__cv_probe");
      return s;
    } catch (e) {
      var mem = {};
      return { getItem: function (k) { return k in mem ? mem[k] : null; }, setItem: function (k, v) { mem[k] = String(v); }, removeItem: function (k) { delete mem[k]; } };
    }
  }

  function h(doc, tag, attrs, children) {
    var el = doc.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) el.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }

  var ICONS = {
    chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    send: ["m22 2-7 20-4-9-9-4z", "M22 2 11 13"],
  };
  function icon(doc, name, size) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", size || 22); svg.setAttribute("height", size || 22);
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
    ICONS[name].forEach(function (d) { var p = doc.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); });
    return svg;
  }

  var PAY_LABEL = { open: "Awaiting payment", paid: "Paid, thank you", expired: "Expired", canceled: "Cancelled", refunded: "Refunded" };
  function formatMoney(minor, currency) {
    try {
      var f = new Intl.NumberFormat(undefined, { style: "currency", currency: String(currency).toUpperCase() });
      return f.format(minor / Math.pow(10, f.resolvedOptions().maximumFractionDigits));
    } catch (e) { return (minor / 100).toFixed(2) + " " + String(currency).toUpperCase(); }
  }

  function linkify(doc, text) {
    var frag = doc.createDocumentFragment();
    var re = /(https?:\/\/[^\s<]+)/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      var a = doc.createElement("a");
      a.href = m[1]; a.textContent = m[1]; a.target = "_blank"; a.rel = "noopener noreferrer nofollow";
      frag.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    return frag;
  }

  /*
   * Styling is driven by CSS custom properties set on the host element:
   *   --c brand colour, --t text colour on the brand colour, --sp launcher spacing, --r panel radius.
   * Surface colours follow the visitor's colour scheme (or data-theme="light|dark" on the script tag / the `theme` option).
   */
  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    ".root{--bg:#fff;--bg2:#f6f6f9;--fg:#15151c;--muted:#4b4b5a;--line:#e2e2ea;--in:#fff;--bot:#eef0ff;--bot-line:#c9ceff;--ring:#15151c;--warn-bg:#fdf3d8;--warn-fg:#6f4700;--err-bg:#fdecec;--err-fg:#8f1818;--err:#b42318;--shadow:0 18px 50px rgba(15,15,30,.28);color:var(--fg)}",
    "@media (prefers-color-scheme:dark){.root:not([data-theme=light]){--bg:#14141a;--bg2:#0d0d12;--fg:#ececf3;--muted:#a9a9bb;--line:#2b2b38;--in:#22222c;--bot:#1f2147;--bot-line:#363a7a;--ring:#ececf3;--warn-bg:#2b2209;--warn-fg:#fcd34d;--err-bg:#2c1518;--err-fg:#fca5a5;--err:#fca5a5;--shadow:0 18px 50px rgba(0,0,0,.6)}}",
    ".root[data-theme=dark]{--bg:#14141a;--bg2:#0d0d12;--fg:#ececf3;--muted:#a9a9bb;--line:#2b2b38;--in:#22222c;--bot:#1f2147;--bot-line:#363a7a;--ring:#ececf3;--warn-bg:#2b2209;--warn-fg:#fcd34d;--err-bg:#2c1518;--err-fg:#fca5a5;--err:#fca5a5;--shadow:0 18px 50px rgba(0,0,0,.6)}",
    "svg{display:block;flex:none}",
    "button{font:inherit}",
    ".launcher{position:fixed;bottom:var(--sp,20px);height:56px;min-width:56px;border:0;cursor:pointer;background:var(--c);color:var(--t);box-shadow:0 8px 24px rgba(15,15,30,.3),0 2px 6px rgba(15,15,30,.2);display:flex;align-items:center;justify-content:center;gap:10px;font-size:15px;font-weight:600;z-index:2147483000;transition:transform .15s ease,box-shadow .15s ease}",
    ".launcher:hover{transform:translateY(-2px)}.launcher:active{transform:scale(.97)}",
    ".launcher.bubble{width:56px;border-radius:50%}",
    ".launcher.pill{padding:0 20px 0 16px;border-radius:999px}",
    ".launcher.icon{width:52px;height:52px;border-radius:min(var(--r,16px),18px)}",
    ".launcher .lbl{display:none}.launcher.pill .lbl{display:inline;white-space:nowrap}",
    ".launcher:focus-visible,.panel button:focus-visible,.panel input:focus-visible,.panel textarea:focus-visible,.panel a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}",
    ".launcher:focus-visible{outline-color:var(--c);box-shadow:0 0 0 2px #fff,0 0 0 5px var(--c)}",
    ".head button:focus-visible{outline-color:var(--t)}",
    ".right{right:var(--sp,20px)}.left{left:var(--sp,20px)}",
    ".badge{position:absolute;top:-5px;right:-5px;min-width:20px;height:20px;border-radius:10px;background:#d92d20;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;border:2px solid var(--bg,#fff)}.badge[hidden]{display:none}",
    ".panel{position:fixed;bottom:calc(var(--sp,20px) + 68px);width:380px;max-width:calc(100vw - 24px);height:600px;max-height:calc(100dvh - var(--sp,20px) - 90px);background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:var(--r,16px);box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden;z-index:2147483000;animation:pop .18s cubic-bezier(.16,1,.3,1)}",
    ".panel.left{transform-origin:bottom left}.panel.right{transform-origin:bottom right}",
    "@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}",
    ".panel[hidden]{display:none}",
    "@media (max-width:480px){.panel{inset:0;width:100%;max-width:none;height:100%;max-height:none;border-radius:0;border:0}}",
    "@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}",
    ".head{background:var(--c);color:var(--t);padding:14px 14px 14px 16px;display:flex;gap:12px;align-items:center;flex:none}",
    ".head img{width:38px;height:38px;border-radius:50%;object-fit:cover;background:rgba(255,255,255,.2)}",
    ".head .who2{min-width:0}.head .ttl{font-weight:650;font-size:16px;line-height:1.25}.head .sub{font-size:12.5px;opacity:.92;line-height:1.35;margin-top:1px}",
    ".head .on{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80;margin-right:6px;box-shadow:0 0 0 2px rgba(255,255,255,.35)}",
    ".head button{margin-left:auto;flex:none;width:34px;height:34px;display:grid;place-items:center;background:transparent;border:0;border-radius:50%;color:inherit;cursor:pointer}.head button:hover{background:rgba(255,255,255,.18)}",
    ".body{background:var(--bg2)}",
    ".rate{align-self:center;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center;font-size:13px;color:var(--muted);margin:6px 0}.rate button{width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;font-weight:600}.rate button:hover,.rate button:focus-visible{background:var(--c);color:var(--t);border-color:var(--c)}",
    ".status{font-size:12.5px;padding:7px 14px;background:var(--warn-bg);color:var(--warn-fg);flex:none}.status[hidden]{display:none}",
    ".msgs{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:6px;overscroll-behavior:contain}",
    ".m{max-width:82%;padding:9px 13px;border-radius:calc(var(--r,16px)*.9) calc(var(--r,16px)*.9) calc(var(--r,16px)*.9) 4px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word;color:var(--fg)}",
    ".m a{color:inherit;text-decoration:underline;text-underline-offset:2px}",
    ".m.in{align-self:flex-start;background:var(--in);border:1px solid var(--line)}",
    ".m.out{align-self:flex-end;background:var(--c);color:var(--t);border-radius:calc(var(--r,16px)*.9) calc(var(--r,16px)*.9) 4px calc(var(--r,16px)*.9)}",
    ".m.bot{background:var(--bot);border:1px solid var(--bot-line)}",
    ".m .who{display:block;font-size:11.5px;font-weight:600;color:var(--muted);margin-bottom:2px}",
    ".m .tag{display:inline-block;font-size:10px;font-weight:700;background:#4338ca;color:#fff;border-radius:4px;padding:0 5px;margin-left:5px;vertical-align:1px}",
    ".m .meta{display:block;font-size:11px;opacity:.85;margin-top:3px;text-align:right}",
    ".m.failed{background:var(--err-bg);color:var(--err-fg);border:1px solid var(--err)}",
    ".m.pay{background:var(--in);color:var(--fg);border:1px solid var(--line);min-width:210px;white-space:normal}",
    ".pay .amt{font-size:22px;font-weight:700;display:block}",
    ".pay .st{font-size:12px;color:var(--muted);display:block;margin:2px 0 8px}",
    ".pay.paid{border-color:#16a34a}.pay.paid .st{color:#15803d}",
    "@media (prefers-color-scheme:dark){.root:not([data-theme=light]) .pay.paid .st{color:#86efac}}.root[data-theme=dark] .pay.paid .st{color:#86efac}",
    ".pay a.btn{display:inline-block;background:var(--c);color:var(--t);padding:8px 14px;border-radius:calc(var(--r,16px)*.6);text-decoration:none;font-weight:600}",
    ".m.sys{align-self:center;background:transparent;border:0;color:var(--muted);font-size:12px;text-align:center}",
    ".typing{font-size:12px;color:var(--muted);padding:0 16px 6px;min-height:20px;flex:none}",
    ".compose{display:flex;gap:8px;align-items:flex-end;padding:10px;border-top:1px solid var(--line);background:var(--bg);flex:none}",
    ".compose textarea{flex:1;resize:none;border:1px solid var(--line);background:var(--bg2);color:var(--fg);border-radius:calc(var(--r,16px)*.75);padding:9px 12px;font-size:14px;line-height:1.4;max-height:120px;min-height:40px}",
    ".compose textarea::placeholder{color:var(--muted)}",
    ".compose .send{flex:none;width:40px;height:40px;display:grid;place-items:center;background:var(--c);color:var(--t);border:0;border-radius:calc(var(--r,16px)*.75);cursor:pointer;padding:0}.compose .send:hover{filter:brightness(1.08)}",
    ".form{padding:18px 16px;display:flex;flex-direction:column;gap:12px;overflow:auto;background:var(--bg)}",
    ".form label{font-size:13px;font-weight:550;display:flex;flex-direction:column;gap:5px;color:var(--fg)}",
    ".form input{border:1px solid var(--line);background:var(--bg2);color:var(--fg);border-radius:calc(var(--r,16px)*.6);padding:10px 12px;font-size:14px}",
    ".form button[type=submit]{background:var(--c);color:var(--t);border:0;border-radius:calc(var(--r,16px)*.6);padding:0 16px;font-size:14px;font-weight:600;cursor:pointer;min-height:42px}",
    ".err{color:var(--err);font-size:13px}.err:empty{display:none}.hint{color:var(--muted);font-size:13px;line-height:1.45;margin:0}",
    ".link{background:transparent!important;color:var(--fg)!important;text-decoration:underline;padding:0!important;border:0;cursor:pointer;min-height:0!important;font-size:12px}",
    ".form .link{font-size:13px;align-self:flex-start}",
    ".qr{align-self:flex-start;display:flex;flex-wrap:wrap;gap:6px;max-width:92%;margin:2px 0 4px}",
    ".qr button{border:1px solid var(--c);background:var(--bg);color:var(--fg);border-radius:999px;padding:7px 13px;font-size:13.5px;font-weight:550;cursor:pointer;min-height:34px}.qr button:hover,.qr button:focus-visible{background:var(--c);color:var(--t)}",
    ".fb{align-self:flex-start;display:flex;gap:4px;align-items:center;font-size:12px;color:var(--muted);margin:-2px 0 4px 2px}.fb button{border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:4px 6px;border-radius:6px}.fb button:hover,.fb button:focus-visible{background:var(--bg);color:var(--fg)}.fb button[aria-pressed=true]{color:var(--c)}",
    ".cform{align-self:stretch;margin:2px 4px 6px;padding:12px;border:1px solid var(--line);border-radius:calc(var(--r,16px)*.8);background:var(--bg);display:flex;flex-direction:column;gap:10px}",
    ".cform .fld{display:flex;flex-direction:column;gap:4px}.cform label{font-size:13px;font-weight:550;color:var(--fg)}.cform .opt{font-weight:400;color:var(--muted)}",
    ".cform input[type=text],.cform input[type=email],.cform input[type=tel],.cform select{border:1px solid var(--line);background:var(--bg2);color:var(--fg);border-radius:calc(var(--r,16px)*.6);padding:9px 11px;font-size:14px;min-height:40px;width:100%}",
    ".cform .phone{display:flex;gap:6px}.cform .phone select{width:42%;flex:none}.cform label.consent{display:flex;flex-direction:row;align-items:flex-start;gap:8px;font-weight:400;font-size:12.5px}.cform .consent input{margin-top:2px}",
    ".cform .fe{color:var(--err);font-size:12.5px}.cform .fe:empty{display:none}.cform .row{display:flex;gap:8px;align-items:center}",
    ".cform .go{background:var(--c);color:var(--t);border:0;border-radius:calc(var(--r,16px)*.6);padding:0 16px;min-height:40px;font-weight:600;cursor:pointer}.cform .skip{background:transparent;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font-size:13px}",
    ".cform .hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}",
    ".cform input:focus-visible,.cform select:focus-visible,.cform button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}",
    ".human{padding:4px 12px 2px;background:var(--bg);border-top:1px solid var(--line);flex:none;text-align:center}.human[hidden]{display:none}.human button{border:0;background:transparent;color:var(--muted);text-decoration:underline;cursor:pointer;font-size:12.5px;padding:3px 6px}.human button:hover,.human button:focus-visible{color:var(--fg)}",
  ].join("\n");

  function createWidget(opts) {
    var win = opts.window || global;
    var doc = opts.document || win.document;
    var fetchImpl = opts.fetch || win.fetch.bind(win);
    var base = (opts.apiBase || "").replace(/\/$/, "");
    var token = opts.token || "";
    var preview = opts.preview || "";
    var store = opts.storage || safeStorage(win);
    // a preview flag changes on every use; keep its sessions apart from the real token's
    var keyPrefix = preview ? "cv_preview_" : "cv_" + token.slice(-8) + "_";
    var state = {
      config: null, session: null, room: null, messages: [], pending: {}, socket: null, connected: false,
      open: false, view: OPEN_STATE.CHAT, unread: 0, typingTimer: null, pollTimer: null, destroyed: false, lastReadId: null, error: "", info: "",
    };
    var els = {};

    var deviceId = store.getItem(keyPrefix + "device");
    if (!deviceId) { deviceId = "d" + uuid().replace(/-/g, ""); store.setItem(keyPrefix + "device", deviceId); }
    try { state.session = JSON.parse(store.getItem(keyPrefix + "session") || "null"); } catch (e) { state.session = null; }

    /* ---------- http ---------- */
    function api(path, o) {
      o = o || {};
      var headers = { "x-device-id": deviceId };
      if (preview) headers["x-preview"] = preview; else headers["x-api-key"] = token;
      if (state.session && !o.noSession) headers["x-support-session"] = state.session.session_token;
      if (o.body !== undefined) headers["content-type"] = "application/json";
      return fetchImpl(base + path, { method: o.method || "GET", headers: headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined })
        .then(function (res) {
          return res.text().then(function (text) {
            var data = null;
            try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
            if (!res.ok) {
              var err = new Error((data && data.error && data.error.message) || "Request failed");
              err.status = res.status; err.code = data && data.error && data.error.code; err.details = data && data.error && data.error.details;
              throw err;
            }
            return data;
          });
        });
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
        var prev = state.messages[i];
        state.messages[i] = Object.assign({}, prev, m, { local: false });
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

    /* ---------- rendering ---------- */
    function applyTheme() {
      var w = state.config.widget;
      var side = w.launcher_position === "left" ? "left" : "right";
      var style = w.launcher_style === "pill" || w.launcher_style === "icon" ? w.launcher_style : "bubble";
      var radius = typeof w.radius === "number" ? Math.max(0, Math.min(24, w.radius)) : 16;
      els.root.style.setProperty("--c", w.primary_color);
      els.root.style.setProperty("--t", w.text_color);
      els.root.style.setProperty("--sp", w.launcher_spacing + "px");
      els.root.style.setProperty("--r", radius + "px");
      els.launcher.className = "launcher " + side + " " + style;
      els.panel.className = "panel " + side;
      if (els.lbl) els.lbl.textContent = w.launcher_label || "Chat with us";
    }

    function renderHeader() {
      var w = state.config.widget;
      els.head.textContent = "";
      if (w.logo_url) els.head.appendChild(h(doc, "img", { src: w.logo_url, alt: "" }));
      var sub = h(doc, "div", { class: "sub" });
      if (state.config.agents_available > 0 && state.config.office_open !== false) sub.appendChild(h(doc, "span", { class: "on", "aria-hidden": "true" }));
      sub.appendChild(doc.createTextNode(w.intro));
      els.head.appendChild(h(doc, "div", { class: "who2" }, [h(doc, "div", { class: "ttl", text: w.title }), sub]));
      var closeBtn = h(doc, "button", { type: "button", "aria-label": "Close chat", onclick: close }, [icon(doc, "x", 20)]);
      els.head.appendChild(closeBtn);
    }

    // a form card being filled in survives the re-renders caused by incoming events: the draft is kept per message and focus is restored
    function renderMessages() {
      var ae = els.shadow && els.shadow.activeElement, keep = null;
      if (ae && ae.closest && ae.closest(".cform") && ae.name) { var fm = ae.closest(".cform"); keep = { qid: fm.getAttribute("data-form"), name: ae.name }; }
      renderMessagesInner();
      if (keep && els.list) { var again = els.list.querySelector('.cform[data-form="' + keep.qid + '"] [name="' + keep.name + '"]'); if (again && again.focus) again.focus(); }
    }
    function renderMessagesInner() {
      if (!els.list) return;
      els.list.textContent = "";
      sorted().forEach(function (m) {
        if (m.deleted) return;
        var sender = m.sender || {};
        var mine = sender.type === "contact";
        var cls = "m " + (sender.type === "system" ? "sys" : mine ? "out" : "in") + (sender.type === "bot" ? " bot" : "") + (m.delivery === "failed" || m.status === "failed" ? " failed" : "");
        var body = h(doc, "div", { class: cls, "data-id": m.id || null, "data-qid": m.client_msg_id || null });
        if (!mine && sender.type !== "system" && sender.name) {
          var who = h(doc, "span", { class: "who", text: sender.name });
          if (m.meta && m.meta.ai) who.appendChild(h(doc, "span", { class: "tag", text: (m.meta.agent && m.meta.agent.label) || "AI" }));
          body.appendChild(who);
        }
        var text = m.content_text != null ? m.content_text : m.content || "";
        var card = m.meta && m.meta.card && m.meta.card.type === "payment_request" ? m.meta.card : null;
        if (card) {
          body.className += " pay " + String(card.status).replace(/[^a-z]/g, "");
          body.appendChild(h(doc, "span", { class: "amt", text: formatMoney(card.amount, card.currency) }));
          body.appendChild(h(doc, "span", { text: String(card.description || "") }));
          body.appendChild(h(doc, "span", { class: "st", text: PAY_LABEL[card.status] || "" }));
          // only a Stripe-hosted https page is ever offered as a link
          if (card.status === "open" && /^https:\/\//.test(card.url || "")) body.appendChild(h(doc, "a", { class: "btn", href: card.url, target: "_blank", rel: "noopener noreferrer", text: "Pay now" }));
        } else {
          var span = h(doc, "span");
          span.appendChild(linkify(doc, text));
          body.appendChild(span);
        }
        if (mine) {
          var meta = h(doc, "span", { class: "meta" });
          if (m.status === "failed") {
            meta.appendChild(doc.createTextNode("Not sent • "));
            meta.appendChild(h(doc, "button", { type: "button", class: "link", "data-retry": m.client_msg_id, text: "Retry", onclick: function () { resend(m.client_msg_id); } }));
          } else if (m.local) meta.textContent = "Sending…";
          else meta.textContent = m.read ? "Read" : "Sent";
          body.appendChild(meta);
        }
        els.list.appendChild(body);
        if (!mine && m.id) renderCardExtras(m);
      });
      renderRating();
      renderHumanButton();
      els.list.scrollTop = els.list.scrollHeight;
    }

    /* ---------- AI agent: quick replies, thumbs, "Talk to a person" ---------- */
    function lastOf(pred) { var l = sorted().filter(pred); return l[l.length - 1]; }
    function renderCardExtras(m) {
      var card = m.meta && m.meta.card;
      if (card && card.type === "quick_replies" && !card.answered && card.options && m === lastOf(function (x) { return !x.deleted && x.sender && x.sender.type !== "system"; })) {
        var row = h(doc, "div", { class: "qr", role: "group", "aria-label": "Quick replies" });
        card.options.forEach(function (o) {
          row.appendChild(h(doc, "button", { type: "button", "data-option": o.id, text: o.label, onclick: function () { tapQuickReply(m, o.id); } }));
        });
        els.list.appendChild(row);
      }
      if (card && card.type === "contact_form" && !card.answered && card.fields && m === lastOf(function (x) { return x.meta && x.meta.card && x.meta.card.type === "contact_form"; })) {
        els.list.appendChild(renderContactForm(m, card));
      }
      if (card && card.type === "csat" && state.room && state.room.ticket && state.room.ticket.csat_pending && m === lastOf(function (x) { return x.meta && x.meta.card && x.meta.card.type === "csat"; })) {
        var box = h(doc, "div", { class: "rate", role: "group", "aria-label": "How did we do?" });
        box.appendChild(h(doc, "span", { text: "How did we do?" }));
        [1, 2, 3, 4, 5].forEach(function (n) {
          box.appendChild(h(doc, "button", { type: "button", "aria-label": n + " out of 5", "data-score": String(n), text: String(n), onclick: function () {
            state.room.ticket = Object.assign({}, state.room.ticket, { csat_pending: false });
            api("/public/rooms/" + state.room.id + "/ticket-csat", { method: "POST", body: { score: n } }).catch(function () {}).then(renderMessages);
          } }));
        });
        els.list.appendChild(box);
      }
      if (m.sender && m.sender.type === "bot" && m.meta && m.meta.ai && m.kind !== "system" && m === lastOf(function (x) { return x.sender && x.sender.type === "bot" && x.meta && x.meta.ai; })) {
        var key = keyPrefix + "fb_" + m.id;
        var voted = store.getItem(key);
        var fb = h(doc, "div", { class: "fb", role: "group", "aria-label": "Was this helpful?" });
        fb.appendChild(h(doc, "span", { text: voted ? "Thanks for your feedback." : "Was this helpful?" }));
        if (!voted) {
          [[1, "\uD83D\uDC4D", "Helpful"], [-1, "\uD83D\uDC4E", "Not helpful"]].forEach(function (o) {
            fb.appendChild(h(doc, "button", { type: "button", "aria-label": o[2], "aria-pressed": "false", "data-rating": String(o[0]), text: o[1], onclick: function () {
              store.setItem(key, String(o[0]));
              api("/public/rooms/" + state.room.id + "/messages/" + m.id + "/feedback", { method: "POST", body: { rating: o[0] } }).catch(function () {}).then(renderMessages);
            } }));
          });
        }
        els.list.appendChild(fb);
      }
    }
    var COUNTRIES = [["US","United States (+1)"],["CA","Canada (+1)"],["GB","United Kingdom (+44)"],["IE","Ireland (+353)"],["AU","Australia (+61)"],["NZ","New Zealand (+64)"],["DE","Germany (+49)"],["FR","France (+33)"],["ES","Spain (+34)"],["IT","Italy (+39)"],["NL","Netherlands (+31)"],["BE","Belgium (+32)"],["CH","Switzerland (+41)"],["AT","Austria (+43)"],["SE","Sweden (+46)"],["NO","Norway (+47)"],["DK","Denmark (+45)"],["FI","Finland (+358)"],["PL","Poland (+48)"],["PT","Portugal (+351)"],["BR","Brazil (+55)"],["MX","Mexico (+52)"],["IN","India (+91)"],["JP","Japan (+81)"],["SG","Singapore (+65)"],["ZA","South Africa (+27)"],["AE","United Arab Emirates (+971)"]];
    function defaultCountry() {
      var m = /[-_]([A-Za-z]{2})\b/.exec((win.navigator && win.navigator.language) || "");
      var c = m ? m[1].toUpperCase() : (state.config && state.config.default_region) || "US";
      return COUNTRIES.some(function (x) { return x[0] === c; }) ? c : ((state.config && state.config.default_region) || "US");
    }
    /* a form card: the server asked for details; every value is validated here for speed and again by the server */
    function zone() { try { return win.Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch (e) { return undefined; } }
    function renderContactForm(m, card) {
      var form = h(doc, "form", { class: "cform", "aria-label": "Your details", novalidate: true, "data-form": m.id });
      var inputs = {}, errs = {};
      state.drafts = state.drafts || {};
      var draft = state.drafts[m.id] = state.drafts[m.id] || {};
      var country = null;
      card.fields.forEach(function (f) {
        var err = h(doc, "div", { class: "fe", role: "alert" });
        errs[f.key] = err;
        var input;
        if (f.type === "select") {
          input = h(doc, "select", { name: f.key }, [h(doc, "option", { value: "", text: "" })].concat((f.options || []).map(function (o) { return h(doc, "option", { value: o, text: o }); })));
        } else {
          input = h(doc, "input", { type: f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text", name: f.key, autocomplete: f.key === "name" ? "name" : f.key === "email" ? "email" : f.key === "phone" ? "tel" : "off", maxlength: "200", "aria-required": f.required ? "true" : null });
        }
        inputs[f.key] = input;
        if (draft[f.key]) input.value = draft[f.key]; else if (f.prefill) input.value = f.prefill;
        input.addEventListener("input", function () { draft[f.key] = input.value; });
        input.addEventListener("change", function () { draft[f.key] = input.value; });
        var control = input;
        if (f.key === "phone") {
          country = h(doc, "select", { "aria-label": "Country", name: "country" }, COUNTRIES.map(function (c) { return h(doc, "option", { value: c[0], text: c[1] }); }));
          country.value = draft.__country || defaultCountry();
          country.addEventListener("change", function () { draft.__country = country.value; });
          control = h(doc, "div", { class: "phone" }, [country, input]);
        }
        var fid = "cf-" + m.id + "-" + f.key;
        input.id = fid;
        form.appendChild(h(doc, "div", { class: "fld" }, [h(doc, "label", { for: fid }, [f.label + "", f.required ? null : h(doc, "span", { class: "opt", text: " (optional)" })]), control, err]));
      });
      var consent = null, consentErr = h(doc, "div", { class: "fe", role: "alert" });
      if (card.consent) {
        consent = h(doc, "input", { type: "checkbox", name: "consent" });
        consent.checked = !!draft.__consent;
        consent.addEventListener("change", function () { draft.__consent = consent.checked; });
        var text = h(doc, "span", { text: card.consent.text + " " });
        if (card.consent.privacy_url && /^https?:\/\//.test(card.consent.privacy_url)) text.appendChild(h(doc, "a", { href: card.consent.privacy_url, target: "_blank", rel: "noopener noreferrer", text: "Privacy policy" }));
        form.appendChild(h(doc, "label", { class: "consent" }, [consent, text]));
        form.appendChild(consentErr);
      }
      var hp = h(doc, "input", { type: "text", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
      form.appendChild(h(doc, "div", { class: "hp", "aria-hidden": "true" }, [hp]));
      var fail = h(doc, "div", { class: "fe", role: "alert" });
      var go = h(doc, "button", { type: "submit", class: "go", text: "Send" });
      var row = h(doc, "div", { class: "row" }, [go]);
      if (card.skippable) row.appendChild(h(doc, "button", { type: "button", class: "skip", "data-skip": "1", text: "Skip", onclick: function () {
        api("/public/rooms/" + state.room.id + "/forms/" + m.id + "/skip", { method: "POST", body: {} }).catch(function () {}).then(function () { return loadMessages(); }).then(renderMessages);
      } }));
      form.appendChild(fail); form.appendChild(row);
      function localCheck() {
        var bad = false;
        card.fields.forEach(function (f) {
          var v = (inputs[f.key].value || "").trim(), msg = "";
          if (!v && f.required) msg = "This is required";
          else if (v && f.key === "email" && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) msg = "Enter a valid email address";
          errs[f.key].textContent = msg;
          inputs[f.key].setAttribute("aria-invalid", msg ? "true" : "false");
          if (msg) bad = true;
        });
        if (consent) {
          var filled = card.fields.some(function (f) { return f.key !== "name" && (inputs[f.key].value || "").trim(); });
          consentErr.textContent = filled && !consent.checked ? "Please agree to continue" : "";
          if (consentErr.textContent) bad = true;
        }
        return !bad;
      }
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        fail.textContent = "";
        if (!localCheck()) { var first = form.querySelector("[aria-invalid=true]"); if (first && first.focus) first.focus(); return; }
        var values = {};
        card.fields.forEach(function (f) { var v = (inputs[f.key].value || "").trim(); if (v) values[f.key] = v; });
        go.disabled = true;
        api("/public/rooms/" + state.room.id + "/forms/" + m.id, { method: "POST", body: { values: values, consent: !!(consent && consent.checked), country: country ? country.value : undefined, website: hp.value || undefined, timezone: zone() } }).then(function () {
          return loadMessages().then(renderMessages);
        }).catch(function (ex) {
          go.disabled = false;
          var d = ex.details && ex.details.errors;
          if (ex.code === "ALREADY_ANSWERED") return loadMessages().then(renderMessages);
          if (d) { Object.keys(d).forEach(function (k) { if (errs[k]) errs[k].textContent = d[k]; else if (k === "consent") consentErr.textContent = d[k]; }); return; }
          fail.textContent = "We could not save that. Please try again.";
        });
      });
      return form;
    }
    function tapQuickReply(m, optionId) {
      // mark it answered locally so the buttons disappear at once; the server's message:updated confirms
      m.meta = Object.assign({}, m.meta, { card: Object.assign({}, m.meta.card, { answered: optionId }) });
      renderMessages();
      return api("/public/rooms/" + state.room.id + "/quick-reply", { method: "POST", body: { message_id: m.id, option_id: optionId } }).then(function (r) {
        if (r && r.ticket) state.room.ticket = r.ticket;
        // "Yes" to the assistant's offer of a spoken call: the call starts here, in the browser, where the microphone is
        if (r && r.start_ai_call && state.aiCalls) state.aiCalls.start(r.start_ai_call);
        return loadMessages().then(renderMessages);
      }).catch(function () { return loadMessages().then(renderMessages); });
    }
    function humanNeeded() {
      var tk = state.room && state.room.ticket;
      return !!state.room && !(tk && (tk.status === "waiting_for_human" || tk.status === "open"));
    }
    function renderHumanButton() {
      if (!els.human) return;
      els.human.hidden = !humanNeeded();
    }
    function requestHuman() {
      if (!state.room) return;
      els.human.hidden = true;
      return api("/public/rooms/" + state.room.id + "/request-human", { method: "POST", body: {} }).then(function (r) {
        if (r && r.ticket) state.room.ticket = r.ticket;
        return loadMessages().then(renderMessages);
      }).catch(function () { els.human.hidden = false; });
    }

    /* ---------- satisfaction rating: offered once after the team closes the conversation ---------- */
    // The server states when the team closed the conversation (`room.closed_marker = {id, seq}`); the close line itself is internal and never sent.
    // A real message with a higher seq, or one still unconfirmed, means the conversation is live again.
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
    function applyRoomState(room) {
      if (!room || !state.room || room.id !== state.room.id) return;
      state.room.status = room.status;
      state.room.closed_marker = room.closed_marker || null;
      if (room.ticket !== undefined) state.room.ticket = room.ticket;
    }
    function renderRating() {
      var marker = state.room && closedMarker();
      if (!marker) return;
      var key = keyPrefix + "rated_" + state.room.id + "_" + marker;
      if (store.getItem(key)) { els.list.appendChild(h(doc, "div", { class: "m sys", text: "Thanks for your feedback." })); return; }
      var box = h(doc, "div", { class: "rate", role: "group", "aria-label": "How did we do?" });
      box.appendChild(h(doc, "span", { text: "How did we do?" }));
      [1, 2, 3, 4, 5].forEach(function (n) {
        box.appendChild(h(doc, "button", { type: "button", "aria-label": n + " out of 5", "data-score": String(n), text: String(n), onclick: function () {
          store.setItem(key, String(n));
          api("/public/rooms/" + state.room.id + "/csat", { method: "POST", body: { score: n } }).catch(function () {}).then(renderMessages);
        } }));
      });
      els.list.appendChild(box);
    }

    function renderTyping(name) { if (els.typing) els.typing.textContent = name ? name + " is typing…" : ""; }
    function renderBadge() {
      els.badge.textContent = state.unread > 9 ? "9+" : String(state.unread);
      els.badge.hidden = !(state.unread > 0 && !state.open);
    }

    function renderBody() {
      els.body.textContent = "";
      var w = state.config.widget;
      if (state.view === OPEN_STATE.FORM) return renderForm(w);
      if (state.view === OPEN_STATE.OTP) return renderOtp();
      els.banner = h(doc, "div", { class: "status", role: "status", hidden: true, text: "Reconnecting… messages will be sent when you are back online." });
      els.list = h(doc, "div", { class: "msgs", role: "log", "aria-live": "polite", "aria-label": "Conversation" });
      els.typing = h(doc, "div", { class: "typing", "aria-live": "polite" });
      els.input = h(doc, "textarea", { rows: "1", placeholder: "Type your message…", "aria-label": "Message", maxlength: "4000" });
      els.input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      });
      els.input.addEventListener("input", sendTyping);
      els.input.addEventListener("input", function () { els.input.style.height = "auto"; els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px"; });
      var send = h(doc, "button", { type: "button", class: "send", "aria-label": "Send message", onclick: submit }, [icon(doc, "send", 18)]);
      els.human = h(doc, "div", { class: "human", hidden: true }, [h(doc, "button", { type: "button", "data-human": "1", text: "Talk to a person", onclick: requestHuman })]);
      els.body.appendChild(els.banner); els.body.appendChild(els.list); els.body.appendChild(els.typing); els.body.appendChild(els.human);
      mountCallBar();
      els.body.appendChild(h(doc, "div", { class: "compose" }, [els.input, send]));
      els.body.style.display = "flex"; els.body.style.flexDirection = "column"; els.body.style.flex = "1"; els.body.style.minHeight = "0";
      els.banner.hidden = state.connected || !state.session;
      renderMessages();
    }

    function requiredInfo(w) {
    var need = w.required_info.slice(), f = (w.visitor_info && w.visitor_info.fields) || {};
    ["name", "email", "phone"].forEach(function (k) { if (f[k] === "required" && need.indexOf(k) < 0) need.push(k); });
    return need;
  }
    function renderForm(w) {
      var need = requiredInfo(w);
      if (w.chat_type === "sms" && need.indexOf("phone") < 0) need.push("phone");
      var labels = { name: "Your name", email: "Email", phone: "Phone number" };
      var inputs = {};
      var form = h(doc, "form", { class: "form", "aria-label": "Your details" });
      form.appendChild(h(doc, "p", { class: "hint", text: w.chat_type === "sms" ? "Share your details. We'll also reply by text message." : "Tell us a little about you so we can help." }));
      ["name", "email", "phone"].forEach(function (k) {
        var req = need.indexOf(k) >= 0;
        var input = h(doc, "input", { type: k === "email" ? "email" : k === "phone" ? "tel" : "text", name: k, required: req, autocomplete: k === "phone" ? "tel" : k });
        inputs[k] = input;
        form.appendChild(h(doc, "label", null, [labels[k] + (req ? "" : " (optional)"), input]));
      });
      var err = h(doc, "div", { class: "err", role: "alert", text: state.error });
      form.appendChild(err);
      form.appendChild(h(doc, "button", { type: "submit", text: "Start chat" }));
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        state.error = "";
        startSession({ name: inputs.name.value.trim(), email: inputs.email.value.trim(), phone: inputs.phone.value.trim() }).catch(function (ex) {
          state.error = ex.message; renderBody();
        });
      });
      els.body.appendChild(form);
      var first = form.querySelector("input");
      if (first && first.focus) first.focus();
    }

    function renderOtp() {
      var form = h(doc, "form", { class: "form" });
      form.appendChild(h(doc, "p", { class: "hint", text: state.info || "We found an existing conversation. Verify it's you to continue." }));
      var code = h(doc, "input", { type: "text", inputmode: "numeric", pattern: "[0-9]{5}", maxlength: "5", name: "code", autocomplete: "one-time-code", "aria-label": "5-digit code" });
      form.appendChild(h(doc, "label", null, ["Verification code", code]));
      form.appendChild(h(doc, "div", { class: "err", role: "alert", text: state.error }));
      form.appendChild(h(doc, "button", { type: "submit", text: "Verify" }));
      form.appendChild(h(doc, "button", { type: "button", class: "link", "data-send-code": "1", text: "Send me a code", onclick: function () { requestOtp(); } }));
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        verifyOtpCode(code.value.trim());
      });
      els.body.appendChild(form);
    }

    /* ---------- session / room ---------- */
    function saveSession(s) { state.session = s; store.setItem(keyPrefix + "session", JSON.stringify(s)); }

    function startSession(info) {
      var body = {};
      if (info.name) body.name = info.name;
      if (info.email) body.email = info.email;
      if (info.phone) body.phone = info.phone;
      return api("/public/sessions", { method: "POST", body: body, noSession: true }).then(function (s) {
        saveSession(s);
        return ensureRoom(!!s.requires_verification);
      });
    }

    function needsForm() {
      var w = state.config.widget;
      return !state.session && (requiredInfo(w).length > 0 || w.chat_type === "sms");
    }

    function ensureSession() {
      if (state.session) return Promise.resolve();
      if (needsForm()) { state.view = OPEN_STATE.FORM; renderBody(); return Promise.resolve("form"); }
      return startSession({});
    }

    function ensureRoom(requiresVerification) {
      return api("/public/rooms").then(function (r) {
        if (r.data.length) return r.data[0];
        return api("/public/rooms", { method: "POST", body: {} }).then(function (x) { return x.room; });
      }).catch(function (e) {
        if (e.code === "VERIFICATION_REQUIRED" || requiresVerification) { state.view = OPEN_STATE.OTP; state.info = ""; renderBody(); return null; }
        throw e;
      }).then(function (room) {
        if (!room) return null;
        state.room = room; state.view = OPEN_STATE.CHAT;
        return loadMessages().then(function () { renderBody(); connectSocket(); });
      });
    }

    function requestOtp() {
      state.error = "";
      return api("/public/otp/send", { method: "POST", body: {} }).then(function (r) {
        state.info = "We sent a 5-digit code by " + r.channel + ". It expires in 2 minutes.";
        renderBody();
      }).catch(function (e) { state.error = e.message; renderBody(); });
    }

    function verifyOtpCode(code) {
      state.error = "";
      return api("/public/otp/verify", { method: "POST", body: { code: code } }).then(function () {
        saveSession(Object.assign({}, state.session, { verified: true }));
        return ensureRoom(false);
      }).catch(function (e) { state.error = e.message; renderBody(); });
    }

    function loadMessages() {
      return api("/public/rooms/" + state.room.id + "/messages?limit=50").then(function (r) {
        applyRoomState(r.room);
        var local = state.messages.filter(function (m) { return m.local; });
        state.messages = r.data.concat(local.filter(function (m) { return findIndexIn(r.data, m) < 0; }));
        scheduleRead();
      });
    }
    function findIndexIn(list, m) {
      for (var i = 0; i < list.length; i++) if ((m.client_msg_id && list[i].client_msg_id === m.client_msg_id) || (m.id && list[i].id === m.id)) return i;
      return -1;
    }

    /* ---------- sockets ---------- */
    function ioFactory() { return opts.io || win.io; }

    function connectSocket() {
      if (state.socket || !state.session) return;
      var io = ioFactory();
      if (!io) { loadSocketScript().then(connectSocket).catch(startPolling); return; }
      var socket = io(base + "/ws/" + state.session.workspace_id, { auth: { session: state.session.session_token, deviceId: deviceId }, transports: ["websocket", "polling"], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 30000, randomizationFactor: 0.8 });
      state.socket = socket;
      mountCalls(socket);
      mountAiCalls(socket);
      socket.on("connect", function () {
        state.connected = true; stopPolling();
        if (els.banner) els.banner.hidden = true;
        loadMessages().then(function () { renderMessages(); flushPending(); });
      });
      socket.on("disconnect", function (reason) {
        state.connected = false; if (els.banner) els.banner.hidden = false;
        // the server closed us on purpose (drain / limit): wait a random time so a whole fleet does not return in the same second
        if (reason === "io server disconnect") {
          var wait = state.drainWait != null ? state.drainWait : 500 + Math.random() * 4500;
          state.drainWait = null;
          setTimeout(function () { if (!state.destroyed && state.socket === socket) socket.connect(); }, wait);
        }
      });
      socket.on("server:resync", function () { loadMessages().then(renderMessages).catch(function () {}); });
      socket.on("server:draining", function (p) { state.drainWait = Math.max(500, (p && p.reconnect_in_ms) || 0) + Math.random() * 1000; });
      socket.on("connect_error", function () { state.connected = false; if (els.banner) els.banner.hidden = false; startPolling(); });
      socket.on("message:new", function (p) { onIncoming(p.message); });
      socket.on("room:updated", function (p) { applyRoomState(p && p.room); renderMessages(); });
      socket.on("message:updated", function (p) { upsert(p.message); renderMessages(); });
      socket.on("ticket:updated", function (p) { if (state.room && p && p.room_id === state.room.id) { state.room.ticket = p.ticket; renderMessages(); } });
      socket.on("message:deleted", function (p) {
        state.messages = state.messages.filter(function (m) { return m.id !== p.message_id; });
        renderMessages();
      });
      socket.on("message:receipt", function (p) {
        if (!p.reader || p.reader.type !== "agent") return;
        state.messages.forEach(function (m) { if (m.seq != null && m.seq <= p.up_to_seq && m.sender && m.sender.type === "contact") m.read = true; });
        renderMessages();
      });
      socket.on("typing", function (p) {
        if (!p.typing || (p.who && p.who.type !== "agent")) return renderTyping("");
        renderTyping((p.who && p.who.name) || "Someone");
        clearTimeout(state.typingTimer);
        state.typingTimer = setTimeout(function () { renderTyping(""); }, 4000);
      });
      socket.on("session:verified", function () { loadMessages().then(renderMessages); });
    }

    /* ---------- calls: the visitor side lives in /chat/assets/calls.js, loaded only when the workspace switched calls on ---------- */
    function loadCalls() {
      var C = win.ConversationsCalls || opts.calls;
      if (C) return Promise.resolve(C);
      return new Promise(function (resolve, reject) {
        var s = doc.createElement("script");
        s.src = base + "/chat/assets/calls.js"; s.async = true;
        s.onload = function () { win.ConversationsCalls ? resolve(win.ConversationsCalls) : reject(new Error("calls unavailable")); };
        s.onerror = function () { reject(new Error("calls script failed to load")); };
        doc.head.appendChild(s);
      });
    }
    function mountCalls(socket) {
      var c = state.config.calls;
      if (!c || !c.browser || !c.browser.enabled || state.calls || state.callsLoading) return;
      state.callsLoading = true;
      loadCalls().then(function (C) {
        var style = h(doc, "style", { text: C.css }); els.shadow.appendChild(style);
        state.calls = C.create({ doc: doc, win: win, container: els.panel, getSocket: function () { return state.socket; }, getRoomId: function () { return state.room && state.room.id; }, config: c, emit: function () {}, onRinging: function () { open(); } });
        state.callBar = state.calls.requestBar();
        state.calls.bind(socket);
        mountCallBar();
      }).catch(function () { state.callsLoading = false; /* calls are optional: the chat works without */ });
    }
    function mountCallBar() {
      if (state.callBar && els.human && els.human.parentNode) els.human.parentNode.insertBefore(state.callBar, els.human);
      if (state.aiBar && els.human && els.human.parentNode) els.human.parentNode.insertBefore(state.aiBar, els.human);
    }
    /* calls with the AI assistant: /chat/assets/aicall.js, loaded only when the workspace switched them on. The visitor's browser does the speech. */
    function loadAiCalls() {
      var C = win.ConversationsAiCall || opts.aiCalls;
      if (C) return Promise.resolve(C);
      return new Promise(function (resolve, reject) {
        var s = doc.createElement("script");
        s.src = base + "/chat/assets/aicall.js"; s.async = true;
        s.onload = function () { win.ConversationsAiCall ? resolve(win.ConversationsAiCall) : reject(new Error("ai calls unavailable")); };
        s.onerror = function () { reject(new Error("ai calls script failed to load")); };
        doc.head.appendChild(s);
      });
    }
    function mountAiCalls(socket) {
      var c = state.config.calls;
      if (!c || !c.ai || !c.ai.enabled || state.aiCalls || state.aiCallsLoading) return;
      state.aiCallsLoading = true;
      loadAiCalls().then(function (C) {
        els.shadow.appendChild(h(doc, "style", { text: C.css }));
        state.aiCalls = C.create({
          doc: doc, win: win, container: els.panel, getSocket: function () { return state.socket; }, getRoomId: function () { return state.room && state.room.id; }, config: c, emit: function () {}, engine: opts.speechEngine,
          onFallback: function () { if (els.input && els.input.focus) els.input.focus(); },
        });
        state.aiBar = state.aiCalls.bar();
        state.aiCalls.bind(socket);
        mountCallBar();
      }).catch(function () { state.aiCallsLoading = false; /* optional: the chat works without */ });
    }

    function loadSocketScript() {
      return new Promise(function (resolve, reject) {
        if (ioFactory()) return resolve();
        var s = doc.createElement("script");
        s.src = base + "/socket.io/socket.io.js"; s.async = true;
        s.onload = function () { ioFactory() ? resolve() : reject(new Error("socket.io unavailable")); };
        s.onerror = function () { reject(new Error("socket.io script failed to load")); };
        doc.head.appendChild(s);
      });
    }

    function startPolling() {
      if (state.pollTimer || state.destroyed) return;
      state.pollTimer = setInterval(function () { if (state.room && state.session) loadMessages().then(renderMessages).catch(function () {}); }, opts.pollMs || 5000);
    }
    function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }

    function onIncoming(m) {
      var added = upsert(m);
      renderMessages();
      var fromTeam = m.sender && m.sender.type !== "contact" && m.sender.type !== "system";
      if (added && fromTeam) {
        if (!state.open) { state.unread++; renderBadge(); }
        if (state.config.widget.sound) beep();
        scheduleRead();
      }
    }

    function beep() {
      try {
        var Ctx = win.AudioContext || win.webkitAudioContext;
        if (!Ctx) return;
        var ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination); g.gain.value = 0.05; o.frequency.value = 880; o.start(); o.stop(ctx.currentTime + 0.12);
      } catch (e) { /* sound is optional */ }
    }

    /* ---------- sending ---------- */
    function submit() {
      var text = (els.input.value || "").trim();
      if (!text) return;
      els.input.value = "";
      return send(text);
    }

    function send(text) {
      return ensureRoomForSend().then(function () {
        var qid = uuid();
        state.pending[qid] = { content: text, at: Date.now(), tries: 0 };
        state.messages.push({ local: true, client_msg_id: qid, content_text: text, sender: { type: "contact" }, status: "sending", seq: null });
        renderMessages();
        return transmit(qid);
      });
    }

    function ensureRoomForSend() {
      if (state.room) return Promise.resolve();
      return ensureSession().then(function (r) { if (r === "form") throw new Error("form"); return state.room ? null : ensureRoom(false); });
    }

    function transmit(qid) {
      var p = state.pending[qid];
      if (!p) return Promise.resolve();
      p.tries++; p.at = Date.now();
      var payload = { room_id: state.room.id, kind: "text", source: "dm", content: p.content, client_msg_id: qid };
      var done = function (message) { upsert(Object.assign({}, message, { client_msg_id: qid })); renderMessages(); };
      var fail = function () { mark(qid, "failed"); };
      if (state.socket && state.connected) {
        return new Promise(function (resolve) {
          var timer = setTimeout(function () { fail(); resolve(); }, RESEND_AFTER_MS);
          state.socket.emit("message:send", payload, function (ack) {
            clearTimeout(timer);
            if (ack && ack.ok) done(ack.message); else fail();
            resolve();
          });
        });
      }
      return api("/public/rooms/" + state.room.id + "/messages", { method: "POST", body: { content: p.content, client_msg_id: qid } }).then(done).catch(fail);
    }

    function mark(qid, status) {
      state.messages.forEach(function (m) { if (m.client_msg_id === qid && m.local) m.status = status; });
      renderMessages();
    }
    function resend(qid) { mark(qid, "sending"); return transmit(qid); }
    function flushPending() {
      Object.keys(state.pending).forEach(function (qid) { var m = state.messages.filter(function (x) { return x.client_msg_id === qid && x.local; })[0]; if (m) resend(qid); });
    }

    var typingAt = 0;
    function sendTyping() {
      if (!state.socket || !state.connected || !state.room || Date.now() - typingAt < 2000) return;
      typingAt = Date.now();
      state.socket.emit("typing", { room_id: state.room.id, typing: true });
    }

    var readTimer = null;
    function scheduleRead() {
      if (!state.open || !state.room) return;
      clearTimeout(readTimer);
      readTimer = setTimeout(function () {
        var last = sorted().filter(function (m) { return m.id && !m.local && m.sender && m.sender.type !== "contact"; }).pop();
        if (!last || last.id === state.lastReadId) return;
        state.lastReadId = last.id;
        if (state.socket && state.connected) state.socket.emit("message:read", { room_id: state.room.id, message_id: last.id }, function () {});
        else api("/public/rooms/" + state.room.id + "/read", { method: "POST", body: { message_id: last.id } }).catch(function () {});
      }, 300);
    }

    /* ---------- open / close ---------- */
    function open() {
      if (state.open) return;
      state.open = true; state.unread = 0; els.panel.hidden = false; els.launcher.setAttribute("aria-expanded", "true"); renderBadge();
      var step = state.room ? Promise.resolve() : ensureSession().then(function (r) { return r === "form" ? null : state.room ? null : ensureRoom(false); });
      step.catch(function (e) { state.error = e.message; els.body.textContent = ""; els.body.appendChild(h(doc, "div", { class: "form" }, [h(doc, "div", { class: "err", role: "alert", text: "We couldn't start the chat. " + e.message })])); });
      if (state.room) { renderBody(); scheduleRead(); }
      setTimeout(function () { if (els.input && els.input.focus) els.input.focus(); }, 0);
    }
    function close() {
      state.open = false; els.panel.hidden = true; els.launcher.setAttribute("aria-expanded", "false"); els.launcher.focus && els.launcher.focus();
    }
    function toggle() { state.open ? close() : open(); }

    function destroy() {
      state.destroyed = true; stopPolling();
      if (state.socket) state.socket.disconnect();
      if (els.host && els.host.parentNode) els.host.parentNode.removeChild(els.host);
    }

    /* ---------- boot ---------- */
    function mount() {
      var host = h(doc, "div", { id: "conversations-widget-host" });
      var root = host.attachShadow({ mode: "open" });
      root.appendChild(h(doc, "style", { text: CSS }));
      // custom properties set on the host cascade into the shadow tree; the wrapper carries the colour-scheme override
      els.host = host; els.root = host; els.shadow = root;
      els.wrap = h(doc, "div", { class: "root", "data-theme": opts.theme === "light" || opts.theme === "dark" ? opts.theme : null });
      root.appendChild(els.wrap);
      els.lbl = h(doc, "span", { class: "lbl" });
      els.launcher = h(doc, "button", { type: "button", "aria-label": "Open chat", "aria-expanded": "false", onclick: toggle }, [icon(doc, "chat", 24), els.lbl]);
      els.badge = h(doc, "span", { class: "badge", hidden: true, "aria-label": "unread messages" });
      els.launcher.appendChild(els.badge);
      els.head = h(doc, "div", { class: "head" });
      els.body = h(doc, "div", { class: "body" });
      els.panel = h(doc, "section", { class: "panel", role: "dialog", "aria-label": "Chat", hidden: true }, [els.head, els.body]);
      els.panel.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.open) { e.stopPropagation(); close(); } });
      els.wrap.appendChild(els.launcher); els.wrap.appendChild(els.panel);
      doc.body.appendChild(host);
    }

    function start() {
      return api("/public/widget/config", { noSession: true }).then(function (cfg) {
        state.config = cfg; mount(); applyTheme(); renderHeader(); renderBody();
        if (state.session) {
          // returning visitor: restore the conversation in the background so unread counts and sockets are live
          return ensureRoom(false).catch(function (e) {
            if (e.status === 401) { store.removeItem(keyPrefix + "session"); state.session = null; }
          });
        }
      });
    }

    var api2 = {
      version: VERSION, open: open, close: close, destroy: destroy, send: send,
      getState: function () { return { open: state.open, view: state.view, connected: state.connected, unread: state.unread, room: state.room, messages: sorted(), session: state.session }; },
      deviceId: function () { return deviceId; },
      ready: null,
    };
    api2.ready = start();
    return api2;
  }

  function init(options) {
    var opts = Object.assign({}, options);
    if (!opts.token && !opts.preview) throw new Error("Conversations widget: missing token");
    return createWidget(opts);
  }

  global.ConversationsWidget = { init: init, version: VERSION };

  var script = global.document && global.document.currentScript;
  if (script && script.getAttribute && (script.getAttribute("data-token") || script.getAttribute("data-preview")) && !script.getAttribute("data-manual")) {
    var origin = new URL(script.src, global.location.href).origin;
    var boot = function () {
      var w = init({ token: script.getAttribute("data-token") || undefined, preview: script.getAttribute("data-preview") || undefined, apiBase: origin, theme: script.getAttribute("data-theme") || undefined });
      global.ConversationsWidget.instance = w;
      // data-open="true" opens the panel as soon as the widget is ready (used by the in-app preview page)
      if (script.getAttribute("data-open") === "true") w.ready.then(function () { w.open(); }).catch(function () {});
    };
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", boot); else boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
