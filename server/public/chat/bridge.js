/*!
 * Conversations mobile bridge, protocol v1 (docs/MOBILE-BRIDGE.md, schemas in docs/bridge/).
 * Envelope: { v: 1, id, type, payload, reply_to? }. The host sends commands, the page sends events; both sides answer with `ack`.
 * Loaded by the hosted chat (/chat), by /chat/bridge-test and by the jsdom contract tests (CommonJS export).
 * No eval, no tokens or session ids ever cross this boundary, every inbound message is size-checked, rate-limited and validated.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ConversationsBridge = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PROTOCOL_VERSION = 1;
  var MAX_BYTES = 16384;
  var RATE_LIMIT = { windowMs: 10000, max: 30 };
  var ACK_TIMEOUT_MS = 800;

  var COMMAND_TYPES = ["identify", "setLanguage", "setTheme", "setCustomAttributes", "open", "close", "sendMessage", "reset", "restoreSession", "back", "ack"];
  var EVENT_TYPES = ["ready", "unread_count_changed", "message_received", "conversation_started", "conversation_closed", "link_clicked", "attachment_requested", "auth_required", "error", "close_requested", "ack"];

  var HEX64 = /^[0-9a-f]{64}$/;
  var DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
  var COLOR = /^#[0-9a-fA-F]{6}$/;
  var LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
  var ATTR_KEY = /^[a-z][a-z0-9_]{0,39}$/;

  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function isStr(v, max, min) { return typeof v === "string" && v.length <= max && v.length >= (min || 0); }
  function onlyKeys(o, allowed) { for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && allowed.indexOf(k) < 0) return k; return null; }

  /* ---------- payload validators: return an error message, or null when valid. Unknown keys are rejected (strict, versioned schema). ---------- */
  var VALIDATORS = {
    identify: function (p) {
      var bad = onlyKeys(p, ["external_id", "email", "name", "phone", "identity_hash"]);
      if (bad) return "unknown field " + bad;
      if (p.external_id !== undefined && !isStr(p.external_id, 128, 1)) return "external_id must be 1-128 characters";
      if (p.email !== undefined && !(isStr(p.email, 254, 3) && p.email.indexOf("@") > 0)) return "email is not valid";
      if (p.name !== undefined && !isStr(p.name, 100)) return "name must be at most 100 characters";
      if (p.phone !== undefined && !isStr(p.phone, 40)) return "phone must be at most 40 characters";
      if (p.identity_hash !== undefined && !HEX64.test(p.identity_hash)) return "identity_hash must be 64 hex characters";
      if (p.identity_hash !== undefined && p.external_id === undefined && p.email === undefined) return "identity_hash needs external_id or email";
      return null;
    },
    setLanguage: function (p) {
      var bad = onlyKeys(p, ["locale", "strings"]);
      if (bad) return "unknown field " + bad;
      if (typeof p.locale !== "string" || !LOCALE.test(p.locale)) return "locale must be a BCP 47 tag such as en or pt-BR";
      if (p.strings !== undefined) {
        if (!isObj(p.strings)) return "strings must be an object";
        var keys = Object.keys(p.strings);
        if (keys.length > 120) return "at most 120 strings";
        for (var i = 0; i < keys.length; i++) if (!isStr(p.strings[keys[i]], 300)) return "string " + keys[i] + " must be text of at most 300 characters";
      }
      return null;
    },
    setTheme: function (p) {
      var bad = onlyKeys(p, ["theme", "primary_color", "text_color"]);
      if (bad) return "unknown field " + bad;
      if (p.theme !== undefined && ["light", "dark", "auto"].indexOf(p.theme) < 0) return "theme must be light, dark or auto";
      if (p.primary_color !== undefined && !COLOR.test(p.primary_color)) return "primary_color must be #rrggbb";
      if (p.text_color !== undefined && !COLOR.test(p.text_color)) return "text_color must be #rrggbb";
      return null;
    },
    setCustomAttributes: function (p) {
      var bad = onlyKeys(p, ["attributes"]);
      if (bad) return "unknown field " + bad;
      if (!isObj(p.attributes)) return "attributes must be an object";
      var keys = Object.keys(p.attributes);
      if (keys.length > 20) return "at most 20 attributes";
      for (var i = 0; i < keys.length; i++) {
        var v = p.attributes[keys[i]];
        if (!ATTR_KEY.test(keys[i])) return "attribute key " + keys[i] + " must be lower-case letters, digits and _";
        if (!(v === null || typeof v === "boolean" || (typeof v === "number" && isFinite(v)) || isStr(v, 200))) return "attribute " + keys[i] + " must be text (200), number, boolean or null";
      }
      return null;
    },
    open: function (p) { return onlyKeys(p, []) ? "no fields expected" : null; },
    close: function (p) { return onlyKeys(p, []) ? "no fields expected" : null; },
    back: function (p) { return onlyKeys(p, []) ? "no fields expected" : null; },
    reset: function (p) { return onlyKeys(p, []) ? "no fields expected" : null; },
    sendMessage: function (p) {
      var bad = onlyKeys(p, ["text", "send"]);
      if (bad) return "unknown field " + bad;
      if (!isStr(p.text, 4000, 1)) return "text must be 1-4000 characters";
      if (p.send !== undefined && typeof p.send !== "boolean") return "send must be a boolean";
      return null;
    },
    restoreSession: function (p) {
      var bad = onlyKeys(p, ["device_id"]);
      if (bad) return "unknown field " + bad;
      return typeof p.device_id === "string" && DEVICE_ID.test(p.device_id) ? null : "device_id must be 8-64 characters of A-Z a-z 0-9 _ -";
    },
    ack: function (p) {
      var bad = onlyKeys(p, ["ok", "handled", "error", "result"]);
      if (bad) return "unknown field " + bad;
      if (typeof p.ok !== "boolean") return "ok must be a boolean";
      if (p.handled !== undefined && typeof p.handled !== "boolean") return "handled must be a boolean";
      if (p.result !== undefined && !isObj(p.result)) return "result must be an object";
      if (p.error !== undefined && !(isObj(p.error) && isStr(p.error.code, 64, 1) && isStr(p.error.message, 300))) return "error needs code and message";
      return null;
    },
  };

  /** Validators for page -> host events, used by the contract tests and the conformance page. */
  var EVENT_VALIDATORS = {
    ready: function (p) {
      if (p.protocol !== PROTOCOL_VERSION) return "protocol must be 1";
      if (!isStr(p.page_version, 32, 1) || !DEVICE_ID.test(p.device_id || "") || !isStr(p.locale, 35, 2)) return "page_version, device_id and locale are required";
      if (["light", "dark"].indexOf(p.theme) < 0) return "theme must be light or dark";
      if (!Array.isArray(p.features) || p.features.some(function (f) { return typeof f !== "string"; })) return "features must be a list of text";
      if (!(Number.isInteger(p.unread_count) && p.unread_count >= 0)) return "unread_count must be a non-negative integer";
      return null;
    },
    unread_count_changed: function (p) { return Number.isInteger(p.count) && p.count >= 0 ? null : "count must be a non-negative integer"; },
    message_received: function (p) {
      if (!isStr(p.message_id, 64, 1) || ["agent", "bot"].indexOf(p.sender_type) < 0 || !isStr(p.preview, 140) || typeof p.has_attachments !== "boolean" || typeof p.in_foreground !== "boolean") return "message_id, sender_type, preview, has_attachments and in_foreground are required";
      return null;
    },
    conversation_started: function (p) { return isStr(p.room_id, 64, 1) ? null : "room_id is required"; },
    conversation_closed: function (p) { return isStr(p.room_id, 64, 1) ? null : "room_id is required"; },
    link_clicked: function (p) {
      if (typeof p.url !== "string" || !validateLink(p.url, {}).ok) return "url must be https, mailto or tel";
      return ["message", "attachment", "payment"].indexOf(p.source) >= 0 ? null : "source must be message, attachment or payment";
    },
    attachment_requested: function (p) { return Array.isArray(p.kinds) && p.kinds.length > 0 ? null : "kinds is required"; },
    auth_required: function (p) { return ["identity_invalid", "verification_required", "session_expired", "conflict"].indexOf(p.reason) >= 0 ? null : "reason is not known"; },
    error: function (p) { return isStr(p.code, 64, 1) && isStr(p.message, 300) && typeof p.fatal === "boolean" ? null : "code, message and fatal are required"; },
    close_requested: function (p) { return onlyKeys(p, []) ? "no fields expected" : null; },
    ack: VALIDATORS.ack,
  };

  /* ---------- helpers ---------- */
  function randomId() {
    var c = typeof crypto !== "undefined" ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    var s = "";
    for (var i = 0; i < 24; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function makeEnvelope(type, payload, replyTo) {
    var e = { v: PROTOCOL_VERSION, id: randomId(), type: type, payload: payload || {} };
    if (replyTo) e.reply_to = replyTo;
    return e;
  }

  /**
   * Parse an inbound message (JSON text or object). Never throws.
   * { ok: true, envelope } or { ok: false, reason, id? } where reason is one of: too_large, not_json, not_envelope, version, unknown_type, invalid_payload.
   * An unknown protocol version is ignored (reason "version") so a newer host can talk to an older page.
   */
  function parseEnvelope(raw, kinds) {
    var obj = raw;
    if (typeof raw === "string") {
      if (raw.length > MAX_BYTES) return { ok: false, reason: "too_large" };
      try { obj = JSON.parse(raw); } catch (e) { return { ok: false, reason: "not_json" }; }
    } else if (isObj(raw)) {
      var size;
      try { size = JSON.stringify(raw).length; } catch (e) { return { ok: false, reason: "not_json" }; }
      if (size > MAX_BYTES) return { ok: false, reason: "too_large" };
    }
    if (!isObj(obj) || typeof obj.type !== "string" || typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 64) return { ok: false, reason: "not_envelope" };
    if (obj.v !== PROTOCOL_VERSION) return { ok: false, reason: "version", id: obj.id };
    var allowed = kinds === "events" ? EVENT_TYPES : COMMAND_TYPES;
    if (allowed.indexOf(obj.type) < 0) return { ok: false, reason: "unknown_type", id: obj.id };
    if (!isObj(obj.payload)) return { ok: false, reason: "invalid_payload", id: obj.id, message: "payload must be an object" };
    if (obj.reply_to !== undefined && !isStr(obj.reply_to, 64, 1)) return { ok: false, reason: "not_envelope", id: obj.id };
    var validators = kinds === "events" ? EVENT_VALIDATORS : VALIDATORS;
    var err = validators[obj.type](obj.payload);
    if (err) return { ok: false, reason: "invalid_payload", id: obj.id, message: err };
    return { ok: true, envelope: obj };
  }

  /** Only https, mailto and tel leave the page; "own" is the app's origin (signed attachment links may be http in development). */
  function validateLink(url, opts) {
    var u;
    try { u = new URL(url); } catch (e) { return { ok: false }; }
    if (url.length > 2048) return { ok: false };
    if (u.protocol === "https:" || u.protocol === "mailto:" || u.protocol === "tel:") return { ok: true, url: u.href };
    if (opts && opts.own && u.protocol === "http:" && u.origin === opts.own) return { ok: true, url: u.href };
    return { ok: false };
  }

  /** Same rules as the server's originMatches (server/src/services/visitors.ts): exact host, `*.` wildcard, port only when the pattern has one. */
  function originMatches(origin, pattern) {
    if (!origin || origin === "null" || !pattern) return false;
    var url;
    try { url = new URL(origin); } catch (e) { return false; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    var p = String(pattern).toLowerCase().split(":");
    var pHost = p[0], pPort = p[1];
    if (pPort ? url.port !== pPort : url.port !== "") return false;
    var host = url.hostname.toLowerCase();
    if (pHost.indexOf("*.") === 0) return host.length > pHost.length - 1 && host.slice(-(pHost.length - 1)) === pHost.slice(1);
    return host === pHost;
  }

  /* ---------- transports ---------- */
  /**
   * Pick how to talk to the host. `hint` is the `bridge=` URL parameter; without it the environment is probed.
   * Each transport is { name, send(envelope), post: boolean }.
   */
  function detectTransport(win, hint, allowedPattern) {
    var name = hint;
    if (!name || name === "auto") {
      if (win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.conversations) name = "ios";
      else if (win.ConversationsAndroid) name = "android";
      else if (win.ReactNativeWebView) name = "rn";
      else if (win.ConversationsFlutter) name = "flutter";
      else if (win.parent && win.parent !== win) name = "iframe";
      else name = "none";
    }
    var json = function (e) { return JSON.stringify(e); };
    switch (name) {
      case "ios":
        return { name: name, send: function (e) { win.webkit.messageHandlers.conversations.postMessage(json(e)); } };
      case "android":
        return { name: name, send: function (e) { win.ConversationsAndroid.postMessage(json(e)); } };
      case "rn":
        return { name: name, send: function (e) { win.ReactNativeWebView.postMessage(json(e)); } };
      case "flutter":
        return { name: name, send: function (e) { win.ConversationsFlutter.postMessage(json(e)); } };
      case "iframe":
        return {
          name: name,
          iframe: true,
          // post only to origins the token allows: the parent of this frame is never trusted by name
          send: function (e) {
            if (!win.parent || win.parent === win) return;
            var targets = [];
            try { if (win.document.referrer) targets.push(new URL(win.document.referrer).origin); } catch (x) { /* none */ }
            try { if (win.location.ancestorOrigins && win.location.ancestorOrigins.length) targets.push(win.location.ancestorOrigins[0]); } catch (x) { /* none */ }
            targets = targets.filter(function (o, i) { return targets.indexOf(o) === i && (originMatches(o, allowedPattern) || o === win.location.origin); });
            targets.forEach(function (o) { win.parent.postMessage(e, o); });
          },
        };
      default:
        return { name: "none", send: function () {} };
    }
  }

  /**
   * The bridge endpoint.
   *   handlers[type](payload, envelope) -> result | Promise<result>   (throw { code, message } to nack)
   *   bridge.emit(type, payload)           fire-and-forget event
   *   bridge.emitAwait(type, payload, ms)  event whose ack matters; resolves with the ack payload, or null on timeout
   *   bridge.receive(raw, meta)            feed an inbound message (called by the native host / the window message listener)
   */
  function createBridge(opts) {
    var transport = opts.transport;
    var handlers = opts.handlers || {};
    var now = opts.now || function () { return Date.now(); };
    var onDrop = opts.onDrop || function () {};
    var waiting = {};
    var stamps = [];

    function send(type, payload, replyTo) {
      var env = makeEnvelope(type, payload, replyTo);
      try { transport.send(env); } catch (e) { onDrop("send_failed", e); }
      return env;
    }
    function ack(replyTo, ok, extra) {
      var p = { ok: ok };
      if (extra) for (var k in extra) p[k] = extra[k];
      send("ack", p, replyTo);
    }
    function limited() {
      var t = now();
      stamps = stamps.filter(function (s) { return t - s < RATE_LIMIT.windowMs; });
      if (stamps.length >= RATE_LIMIT.max) return true;
      stamps.push(t);
      return false;
    }

    function receive(raw, meta) {
      if (meta && meta.allowed === false) return onDrop("origin", meta);
      var r = parseEnvelope(raw, "commands");
      if (!r.ok) {
        // an ack for a command we could not read is only possible when we know its id
        if (r.id && r.reason !== "version") ack(r.id, false, { error: { code: r.reason === "unknown_type" ? "UNKNOWN_COMMAND" : "INVALID_PAYLOAD", message: r.message || r.reason } });
        return onDrop(r.reason, r);
      }
      var env = r.envelope;
      if (env.type === "ack") {
        var w = env.reply_to && waiting[env.reply_to];
        if (w) { delete waiting[env.reply_to]; clearTimeout(w.timer); w.resolve(env.payload); }
        return;
      }
      if (limited()) return ack(env.id, false, { error: { code: "RATE_LIMITED", message: "Too many commands; slow down" } });
      var h = handlers[env.type];
      if (!h) return ack(env.id, false, { error: { code: "UNKNOWN_COMMAND", message: env.type } });
      Promise.resolve()
        .then(function () { return h(env.payload, env); })
        .then(function (res) {
          // `handled` is part of the ack contract (back, link_clicked); anything else a command returns travels under `result`
          var extra = {};
          if (res && isObj(res)) {
            if (typeof res.handled === "boolean") extra.handled = res.handled;
            var rest = {}, any = false;
            for (var k in res) if (k !== "handled") { rest[k] = res[k]; any = true; }
            if (any) extra.result = rest;
          }
          ack(env.id, true, extra);
        })
        .catch(function (e) { ack(env.id, false, { error: { code: (e && e.code) || "COMMAND_FAILED", message: String((e && e.message) || "Command failed").slice(0, 300) } }); });
    }

    function emit(type, payload) { return send(type, payload).id; }
    function emitAwait(type, payload, ms) {
      return new Promise(function (resolve) {
        var env = makeEnvelope(type, payload);
        var timer = setTimeout(function () { delete waiting[env.id]; resolve(null); }, ms || ACK_TIMEOUT_MS);
        waiting[env.id] = { resolve: resolve, timer: timer };
        try { transport.send(env); } catch (e) { clearTimeout(timer); delete waiting[env.id]; onDrop("send_failed", e); resolve(null); }
      });
    }
    return { receive: receive, emit: emit, emitAwait: emitAwait, transport: transport };
  }

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    MAX_BYTES: MAX_BYTES,
    RATE_LIMIT: RATE_LIMIT,
    COMMAND_TYPES: COMMAND_TYPES,
    EVENT_TYPES: EVENT_TYPES,
    VALIDATORS: VALIDATORS,
    EVENT_VALIDATORS: EVENT_VALIDATORS,
    makeEnvelope: makeEnvelope,
    parseEnvelope: parseEnvelope,
    validateLink: validateLink,
    originMatches: originMatches,
    detectTransport: detectTransport,
    createBridge: createBridge,
  };
});
