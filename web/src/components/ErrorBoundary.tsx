import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureError } from "../monitoring";

/**
 * Last line of defence for a render crash: a calm full-page message instead of a white screen, and one scrubbed report when
 * monitoring is configured. Nothing about what the user was looking at (names, messages) is read or sent.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    captureError(error, "react");
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-sm text-sm text-muted-foreground">The page hit an unexpected error. Reloading usually fixes it. Your messages are safe.</p>
        <button type="button" className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
