import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { isSupportToken } from "../components/AppLayout";
import { getToken } from "../api/client";
import { ImpersonatePage } from "./ImpersonatePage";

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;

describe("support view", () => {
  it("recognises a support token by its imp claim and nothing else", () => {
    expect(isSupportToken(jwt({ mid: "m", imp: "adm_1" }))).toBe(true);
    expect(isSupportToken(jwt({ mid: "m" }))).toBe(false);
    expect(isSupportToken("garbage")).toBe(false);
    expect(isSupportToken(null)).toBe(false);
  });

  it("takes the token from the fragment, wipes it from the address bar, and goes to the inbox without a refresh token", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, hash: "#token=abc.def.ghi", pathname: "/impersonate", replace });
    const spy = vi.spyOn(window.history, "replaceState");
    render(
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<ImpersonatePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/inbox"));
    expect(spy).toHaveBeenCalledWith(null, "", "/impersonate");
    expect(getToken()).toBe("abc.def.ghi");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("without a token it sends the visitor to sign in", async () => {
    vi.stubGlobal("location", { ...window.location, hash: "", pathname: "/impersonate", replace: vi.fn() });
    render(
      <MemoryRouter initialEntries={["/impersonate"]}>
        <Routes>
          <Route path="/impersonate" element={<ImpersonatePage />} />
          <Route path="/login" element={<p>Login screen</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
  });
});
