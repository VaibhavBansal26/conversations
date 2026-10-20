import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loginApi } from "./api.mjs";

/**
 * A stand-in for a customer's website on its own origin (its own port), embedding widget.js from the app server.
 * The widget talks to the app server cross-origin, exactly as in production, so the browser sends an Origin header and the
 * embed token's domain allow-list is exercised for real (a same-origin page would send no Origin on GET requests).
 */
export async function startCustomerSite(appBase: string, html = "<h1>Acme Shop</h1><p>Our homepage with the chat widget installed.</p>"): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  let token = "";
  const server: Server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme Shop</title>` +
        `<style>body{font-family:system-ui,sans-serif;margin:0;padding:48px;background:#fff;color:#16161d}@media (prefers-color-scheme:dark){body{background:#101014;color:#eee}}</style></head>` +
        `<body><main>${html}</main><script src="${appBase}/widget.js" data-token="${token}" async></script></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const api = await loginApi(appBase);
  const t = await api.post("/tokens", { domain: `127.0.0.1:${port}` });
  token = t.token ?? t.secret ?? t.value;
  return { url: `http://127.0.0.1:${port}/`, token, close: () => new Promise<void>((r) => server.close(() => r())) };
}
