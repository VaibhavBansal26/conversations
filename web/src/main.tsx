import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ApiError } from "./lib/apiError";
import { startMonitoring } from "./monitoring";
import { TooltipProvider } from "./ui";
import "./styles/index.css";

const Toaster = lazy(() => import("./ui/toast").then((m) => ({ default: m.Toaster })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
      <Suspense fallback={null}><Toaster /></Suspense>
      </TooltipProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
// after first paint: a no-op unless the server hands out a DSN (then the SDK is a separate lazy chunk)
setTimeout(() => void startMonitoring(), 1500);
