import http from "node:http";

/** Closed-loop POST load with unique client_msg_ids (autocannon cannot vary a JSON body per request). */
export function postLoad({ url, headers, bodyFor, connections = 32, seconds = 10 }) {
  const u = new URL(url);
  const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
  const lat = [];
  let ok = 0;
  let bad = 0;
  const statuses = {};
  const end = Date.now() + seconds * 1000;
  let n = 0;
  const one = () =>
    new Promise((resolve) => {
      const body = bodyFor(n++);
      const t0 = performance.now();
      const req = http.request({ agent, host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
        res.resume();
        res.on("end", () => {
          lat.push(performance.now() - t0);
          statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
          res.statusCode < 300 ? ok++ : bad++;
          resolve();
        });
      });
      req.on("error", () => {
        bad++;
        resolve();
      });
      req.end(body);
    });
  const loop = async () => {
    while (Date.now() < end) await one();
  };
  return Promise.all(Array.from({ length: connections }, loop)).then(() => {
    agent.destroy();
    lat.sort((a, b) => a - b);
    const p = (q) => Math.round((lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0) * 10) / 10;
    return { req_per_sec: Math.round(ok / seconds), p50_ms: p(0.5), p99_ms: p(0.99), non2xx: bad, statuses };
  });
}
