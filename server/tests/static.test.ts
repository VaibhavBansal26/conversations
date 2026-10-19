import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fullApp } from "./helpers.js";

describe("static caching and compression", () => {
  it("serves widget.js with ETag, 304 revalidation and br/gzip variants", async () => {
    const { app } = await fullApp();
    const plain = await app.request("/widget.js", { headers: { "accept-encoding": "identity" } });
    expect(plain.status).toBe(200);
    const raw = await plain.text();
    const etag = plain.headers.get("etag")!;
    expect(etag).toMatch(/^"/);
    expect(plain.headers.get("cache-control")).toContain("stale-while-revalidate");
    expect(plain.headers.get("vary")).toBe("Accept-Encoding");

    const again = await app.request("/widget.js", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);

    const gz = await app.request("/widget.js", { headers: { "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(raw);

    const br = await app.request("/widget.js", { headers: { "accept-encoding": "gzip, br" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    const brBuf = Buffer.from(await br.arrayBuffer());
    expect(brBuf.length).toBeLessThan(raw.length / 3);
    expect(brotliDecompressSync(brBuf).toString()).toBe(raw);
  });
});
