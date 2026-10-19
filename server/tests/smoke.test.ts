import { describe, expect, it } from "vitest";
import { fullApp } from "./helpers.js";

describe("smoke", () => {
  it("boots, registers and lists rooms", async () => {
    const { http } = await fullApp();
    const reg = await http.post("/api/auth/register", { email: "a@example.test", password: "password123", name: "Ann", workspace_name: "Org" });
    expect(reg.status).toBe(201);
    expect(reg.body.workspace.id).toMatch(/^ws_[0-9a-f]{24}$/);
    const rooms = await http.get("/api/rooms", reg.body.token);
    expect(rooms.status).toBe(200);
    expect(rooms.body.data).toEqual([]);
    expect((await http.get("/healthz")).body.status).toBe("ok");
  });
});
