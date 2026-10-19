import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { setToken } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import { RedirectIfAuthed } from "../auth/RequireAuth";
import { LoginPage } from "./LoginPage";

const session = {
  token: "jwt-token",
  expires_in: 3600,
  user: { id: "u1", name: "Ada", email: "ada@example.test" },
  member: { id: "mem_1", role: "owner", name: "Ada", email: "ada@example.test" },
  workspace: { id: "ws_1", name: "Acme" },
};

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const r = handler(url, init);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function renderLogin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider>
          <Routes>
            <Route element={<RedirectIfAuthed />}>
              <Route path="/login" element={<LoginPage />} />
            </Route>
            <Route path="/inbox" element={<p>Inbox screen</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  setToken(null);
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("has labelled fields and a disabled submit until both are filled", async () => {
    renderLogin();
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "secret-pass");
    expect(submit).toBeEnabled();
  });

  it("shows the server's error message when credentials are rejected", async () => {
    mockFetch(() => ({ status: 401, body: { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } } }));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });

  it("stores the token and redirects to the inbox on success", async () => {
    mockFetch(() => ({ status: 200, body: session }));
    renderLogin();
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "secret-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("Inbox screen")).toBeInTheDocument());
    expect(localStorage.getItem("conversations.token")).toBe("jwt-token");
  });
});
