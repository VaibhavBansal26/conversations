/*!
 * Bridge conformance page (/chat/bridge-test?token=cvt_...). Loads the hosted chat in an iframe, plays the host, and checks that every command
 * is acknowledged and every event is well formed (bridge.js validators, which mirror docs/bridge/*.schema.json). Results are in the table
 * (data-testid="check-<id>", class pass|fail|skip) and window.__bridgeTest for automation.
 */
(function (global) {
  "use strict";
  var B = global.ConversationsBridge;
  var doc = global.document;
  var q = new URLSearchParams(global.location.search);
  var token = q.get("token") || "";
  var frame = doc.getElementById("bt-frame");
  var tbody = doc.querySelector("#bt-table tbody");
  var logEl = doc.getElementById("bt-log");
  var summary = doc.getElementById("bt-summary");
  var events = [];
  var waiters = [];
  var results = [];

  function log(line) { logEl.textContent += line + "\n"; logEl.scrollTop = logEl.scrollHeight; }
  function record(id, label, ok, detail, skipped) {
    results.push({ id: id, ok: ok, skipped: !!skipped, detail: detail || "" });
    var tr = doc.createElement("tr");
    tr.setAttribute("data-testid", "check-" + id);
    var td = function (txt, cls) { var c = doc.createElement("td"); c.textContent = txt; if (cls) c.className = cls; tr.appendChild(c); };
    td(label);
    td(skipped ? "skip" : ok ? "pass" : "fail", skipped ? "skip" : ok ? "pass" : "fail");
    td(detail || "");
    tbody.appendChild(tr);
  }

  // events from the page: every one is validated against the event schema as it arrives
  global.addEventListener("message", function (e) {
    if (e.source !== frame.contentWindow || e.origin !== global.location.origin) return;
    var r = B.parseEnvelope(e.data, "events");
    log("<- " + (typeof e.data === "string" ? e.data : JSON.stringify(e.data)).slice(0, 300));
    events.push({ raw: e.data, parsed: r });
    waiters = waiters.filter(function (w) {
      if (r.ok && w.match(r.envelope)) { clearTimeout(w.timer); w.resolve(r.envelope); return false; }
      return true;
    });
  });

  /** Resolve with the next matching event; with `since` (an index into the event list) events already received from there on count too. */
  function waitFor(match, ms, since) {
    if (since !== undefined) {
      var seen = events.slice(since).filter(function (x) { return x.parsed.ok && match(x.parsed.envelope); })[0];
      if (seen) return Promise.resolve(seen.parsed.envelope);
    }
    return new Promise(function (resolve) {
      var w = { match: match, resolve: resolve, timer: setTimeout(function () { waiters = waiters.filter(function (x) { return x !== w; }); resolve(null); }, ms || 6000) };
      waiters.push(w);
    });
  }
  var ofType = function (type) { return function (env) { return env.type === type; }; };

  function sendRaw(env) { log("-> " + JSON.stringify(env).slice(0, 300)); frame.contentWindow.postMessage(env, global.location.origin); }
  function command(type, payload) {
    var env = B.makeEnvelope(type, payload);
    var p = waitFor(function (e) { return e.type === "ack" && e.reply_to === env.id; }, 8000);
    sendRaw(env);
    return p.then(function (ack) { return ack && ack.payload; });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function inner() { return frame.contentDocument; }

  function run() {
    results = []; events = []; tbody.textContent = ""; logEl.textContent = "";
    summary.textContent = "Running...";
    if (!/^cvt_/.test(token)) { record("token", "A token with the hosted chat enabled is in the URL", false, "open /chat/bridge-test?token=cvt_..."); return finish(); }
    frame.hidden = false;
    frame.src = "/chat?token=" + encodeURIComponent(token) + "&bridge=iframe&locale=en&theme=light";
    var ready;
    return waitFor(ofType("ready"), 15000).then(function (env) {
      ready = env;
      record("ready", "page sends a valid ready event (protocol 1)", !!env, env ? "device_id " + env.payload.device_id.slice(0, 6) + "..." : "no ready event in 15s");
      if (!env) return null;
      var step = Promise.resolve();
      var add = function (fn) { step = step.then(fn); };
      add(function () { return command("identify", { name: "Bridge Test" }).then(function (a) { record("identify", "identify is acknowledged", !!(a && a.ok), JSON.stringify(a)); }); });
      add(function () { return waitFor(ofType("conversation_started"), 12000, 0).then(function (e) { record("conversation_started", "conversation_started event after the session is created", !!e, e ? e.payload.room_id.slice(0, 8) : "no event in 12s"); }); });
      add(function () { return sleep(500).then(function () { return command("setLanguage", { locale: "es" }); }).then(function (a) { return sleep(100).then(function () { record("setLanguage", "setLanguage switches the page language", !!(a && a.ok) && inner().documentElement.lang === "es", "lang=" + inner().documentElement.lang); }); }); });
      add(function () { return command("setLanguage", { locale: "en", strings: { send: "Dispatch" } }).then(function (a) { var b = inner().querySelector(".send"); record("setLanguage_override", "setLanguage strings override a label", !!(a && a.ok) && !!b && b.getAttribute("aria-label") === "Dispatch", b ? b.getAttribute("aria-label") : "no send button"); }); });
      add(function () { return command("setTheme", { theme: "dark" }).then(function (a) { record("setTheme", "setTheme sets the theme", !!(a && a.ok) && inner().documentElement.getAttribute("data-theme") === "dark", JSON.stringify(a)); }); });
      add(function () { return command("setCustomAttributes", { attributes: { plan: "pro", seats: 3, beta: true } }).then(function (a) { record("setCustomAttributes", "setCustomAttributes is acknowledged", !!(a && a.ok), JSON.stringify(a)); }); });
      add(function () { return command("open", {}).then(function (a) { record("open", "open focuses the composer", !!(a && a.ok) && inner().activeElement === inner().querySelector("textarea"), JSON.stringify(a)); }); });
      add(function () { return command("sendMessage", { text: "prefilled by the host" }).then(function (a) { var ta = inner().querySelector("textarea"); record("sendMessage_prefill", "sendMessage without send prefills the composer", !!(a && a.ok) && !!ta && ta.value === "prefilled by the host", JSON.stringify(a)); }); });
      add(function () { inner().querySelector("textarea").value = ""; return command("sendMessage", { text: "Hello from the conformance page https://example.com/docs", send: true }).then(function (a) { record("sendMessage_send", "sendMessage with send:true sends and confirms", !!(a && a.ok && a.sent), JSON.stringify(a)); }); });
      add(function () {
        var link = inner().querySelector('.m.out a[data-cv-link]');
        if (!link) { record("link_clicked", "link_clicked event with a validated URL", false, "no link in the sent message"); return null; }
        var wait = waitFor(ofType("link_clicked"), 4000);
        link.click();
        return wait.then(function (env) {
          if (env) sendRaw(B.makeEnvelope("ack", { ok: true, handled: true }, env.id));
          record("link_clicked", "link_clicked event with a validated URL", !!env && env.payload.url === "https://example.com/docs", env ? env.payload.url : "no event");
        });
      });
      add(function () { return command("back", {}).then(function (a) { record("back", "back answers whether the page handled it", !!(a && a.ok && typeof a.handled === "boolean"), JSON.stringify(a)); }); });
      add(function () { return command("restoreSession", { device_id: "restoredDevice01" }).then(function (a) { record("restoreSession", "restoreSession is acknowledged (ignored when a session exists)", !!(a && a.ok), JSON.stringify(a)); }); });
      add(function () { return command("close", {}).then(function (a) { record("close", "close is acknowledged", !!(a && a.ok), JSON.stringify(a)); }); });
      // protocol hygiene
      add(function () { var env = B.makeEnvelope("open", {}); env.v = 2; var n = events.length; sendRaw(env); return sleep(600).then(function () { record("unknown_version", "an unknown protocol version is ignored (no reply)", !events.slice(n).some(function (x) { return x.parsed.ok && x.parsed.envelope.reply_to === env.id; }), ""); }); });
      add(function () { var env = B.makeEnvelope("explode", {}); var w = waitFor(function (e) { return e.type === "ack" && e.reply_to === env.id; }, 3000); sendRaw(env); return w.then(function (a) { record("unknown_command", "an unknown command gets UNKNOWN_COMMAND", !!a && !a.payload.ok && a.payload.error.code === "UNKNOWN_COMMAND", a ? a.payload.error.code : "no reply"); }); });
      add(function () { return command("setTheme", { theme: "purple" }).then(function (a) { record("invalid_payload", "an invalid payload gets INVALID_PAYLOAD", !!a && !a.ok && a.error.code === "INVALID_PAYLOAD", a && a.error ? a.error.code : "no reply"); }); });
      add(function () { var n = events.length; sendRaw({ v: 1, id: "big-1", type: "identify", payload: { name: new Array(20000).join("x") } }); return sleep(600).then(function () { record("too_large", "an oversized message is dropped", !events.slice(n).some(function (x) { return x.parsed.ok && x.parsed.envelope.reply_to === "big-1"; }), ""); }); });
      var beforeReset = 0;
      add(function () { beforeReset = events.length; return command("reset", {}).then(function (a) { record("reset", "reset ends the session and acknowledges", !!(a && a.ok), JSON.stringify(a)); }); });
      add(function () { return waitFor(ofType("conversation_started"), 12000, beforeReset).then(function (e) { record("reset_new_conversation", "after reset a fresh conversation starts", !!e, e ? e.payload.room_id.slice(0, 8) : "no event"); }); });
      add(function () {
        // 40 commands in a burst: the page enforces its command rate limit
        var acks = [];
        var wait = new Promise(function (resolve) { var t0 = Date.now(); (function poll() { if (acks.length >= 40 || Date.now() - t0 > 6000) return resolve(); setTimeout(poll, 100); })(); });
        var ids = [];
        for (var i = 0; i < 40; i++) ids.push(B.makeEnvelope("open", {}));
        global.addEventListener("message", function collect(e) { var r = B.parseEnvelope(e.data, "events"); if (r.ok && r.envelope.type === "ack" && ids.some(function (x) { return x.id === r.envelope.reply_to; })) acks.push(r.envelope); if (acks.length >= 40) global.removeEventListener("message", collect); });
        ids.forEach(sendRaw);
        return wait.then(function () { var limited = acks.filter(function (a) { return !a.payload.ok && a.payload.error.code === "RATE_LIMITED"; }).length; record("rate_limit", "a burst of commands is rate limited", limited > 0, acks.length + " acks, " + limited + " RATE_LIMITED"); });
      });
      add(function () {
        var bad = events.filter(function (x) { return !x.parsed.ok; });
        record("event_schema", "every event the page sent is valid", bad.length === 0, bad.length ? bad.map(function (x) { return x.parsed.reason + ": " + (x.parsed.message || ""); }).slice(0, 3).join("; ") : events.length + " events checked");
      });
      return step;
    }).then(finish);
  }

  function finish() {
    var failed = results.filter(function (r) { return !r.ok && !r.skipped; }).length;
    summary.textContent = results.length - failed + " passed, " + failed + " failed";
    summary.setAttribute("data-state", failed ? "fail" : "pass");
    global.__bridgeTest = { done: true, passed: results.length - failed, failed: failed, results: results };
  }

  doc.getElementById("bt-run").addEventListener("click", run);
  if (q.get("autorun") === "1") run();
})(window);
