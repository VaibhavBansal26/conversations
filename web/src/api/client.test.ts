import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getToken, onUnauthorized, setToken } from "./client";

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("access token refresh", () => {
  beforeEach(() => {
    localStorage.clear();
    setToken("access-1", "refresh-1");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    onUnauthorized(null);
    setToken(null);
  });

  it("renews an expired access token once and repeats the request", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url} ${(init.headers as Record<string, string>)?.Authorization ?? ""}`);
      if (url === "/api/auth/refresh") return json(200, { token: "access-2", refresh_token: "refresh-2", expires_in: 900 });
      return (init.headers as Record<string, string>).Authorization === "Bearer access-2" ? json(200, { ok: true }) : json(401, { error: { code: "INVALID_TOKEN", message: "expired" } });
    });
    expect(await api.get<{ ok: boolean }>("/rooms")).toEqual({ ok: true });
    expect(calls).toEqual(["GET /api/rooms Bearer access-1", "POST /api/auth/refresh ", "GET /api/rooms Bearer access-2"]);
    expect(getToken()).toBe("access-2");
    expect(localStorage.getItem("conversations.refresh")).toBe("refresh-2");
  });

  it("concurrent 401s share ONE refresh (a refresh token is single use)", async () => {
    let refreshes = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === "/api/auth/refresh") {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { token: "access-2", refresh_token: "refresh-2", expires_in: 900 });
      }
      return (init.headers as Record<string, string>).Authorization === "Bearer access-2" ? json(200, { n: 1 }) : json(401, { error: { code: "INVALID_TOKEN", message: "x" } });
    });
    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);
    expect(refreshes).toBe(1);
  });

  it("signs out when the refresh token is refused, and never tries to refresh an auth endpoint", async () => {
    const out = vi.fn();
    onUnauthorized(out);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return json(401, { error: { code: url === "/api/auth/refresh" ? "REFRESH_REUSED" : "INVALID_TOKEN", message: "no" } });
    });
    await expect(api.get("/rooms")).rejects.toBeTruthy();
    expect(out).toHaveBeenCalledTimes(1);
    expect(urls).toEqual(["/api/rooms", "/api/auth/refresh"]);
    urls.length = 0;
    setToken("access-9", "refresh-9");
    await expect(api.post("/auth/login", {})).rejects.toBeTruthy();
    expect(urls).toEqual(["/api/auth/login"]);
  });

  it("adopts a token another tab already refreshed instead of presenting the old refresh token", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(url);
      return (init.headers as Record<string, string>).Authorization === "Bearer access-other" ? json(200, { ok: true }) : json(401, { error: { code: "INVALID_TOKEN", message: "x" } });
    });
    // while this tab's request was failing, another tab stored a newer pair
    const first = api.get("/rooms");
    localStorage.setItem("conversations.token", "access-other");
    localStorage.setItem("conversations.refresh", "refresh-other");
    await first;
    expect(urls).not.toContain("/api/auth/refresh");
    expect(getToken()).toBe("access-other");
  });
});
