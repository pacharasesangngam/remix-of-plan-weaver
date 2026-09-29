import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthGate, AuthProvider, LogoutButton } from "./AuthGate";
import { apiFetch, setCsrfToken } from "@/lib/api";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setCsrfToken(null); });

function setup(initiallySignedIn = false, initialPath = "/", stallSession = false) {
  let signedIn = initiallySignedIn;
  let offline = false;
  let logoutFails = false;
  const mounted = vi.fn();
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (stallSession && url.endsWith("/auth/session")) return new Promise<Response>((_, reject) => {
      // A real fetch settles when its AbortSignal fires; a hung socket behaves this way.
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    if (offline) throw new Error("offline");
    if (url.endsWith("/auth/login")) { signedIn = true; return Response.json({ ok: true }); }
    if (url.endsWith("/auth/logout")) {
      if (logoutFails) return Response.json({}, { status: 500 });
      signedIn = false; return Response.json({ ok: true });
    }
    if (url.endsWith("/auth/session")) return Response.json({ user: signedIn ? { name: "Internal", provider: "internal" } : null,
      csrfToken: signedIn ? "csrf-test" : null, expiresAt: signedIn ? Date.now() / 1000 + 3600 : null, internalEnabled: true, googleEnabled: true });
    return Response.json({}, { status: signedIn ? 200 : 401 });
  });
  vi.stubGlobal("fetch", fetcher);
  function Workspace() {
    const [step, setStep] = useState(() => { mounted(); return "Splash Screen"; });
    return <><LogoutButton /><h1>{step}</h1><button onClick={() => setStep(step === "Splash Screen" ? "Start Screen" : "App")}>Continue</button></>;
  }
  function Location() { return <output data-testid="location">{useLocation().pathname}</output>; }
  const view = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={[initialPath]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <AuthProvider><Location /><AuthGate><Workspace /></AuthGate></AuthProvider>
  </MemoryRouter></QueryClientProvider>);
  return { ...view, fetcher, mounted, resume: () => { stallSession = false; }, expire: () => { signedIn = false; }, offline: () => { offline = true; }, failLogout: () => { logoutFails = true; } };
}

it("ends a stalled session check after ten seconds without rendering a Retry action", async () => {
  vi.useFakeTimers();
  const view = setup(false, "/", true);
  fireEvent.focus(window); fireEvent.focus(window);
  expect(view.fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(screen.queryByText("Checking session…")).toBeNull();
  expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("did not respond");
  expect(view.fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(view.mounted).not.toHaveBeenCalled();
});

it("restarts a suspended request when restored from the browser back-forward cache", async () => {
  const view = setup(false, "/", true);
  const oldSignal = view.fetcher.mock.calls[0][1]!.signal!;
  fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
  expect(oldSignal.aborted).toBe(true);
  view.resume();
  fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
  await screen.findByLabelText("Username");
  expect(view.fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Checking session…")).toBeNull();
});

it("runs a fresh check after a back-forward cache hide instead of reusing the cancelled one", async () => {
  const view = setup(false, "/", true);
  // The page enters the cache, so the generation moves while the check is still in flight.
  fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
  view.resume();
  await act(async () => {});
  fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
  await screen.findByLabelText("Username");
  // The cancelled check must not keep the pending slot, or the restore silently reuses it.
  expect(view.fetcher.mock.calls.filter(([url]) => url.endsWith("/auth/session"))).toHaveLength(2);
  expect(screen.queryByText("Checking session…")).toBeNull();
});

it("gates every route before Splash, then preserves Login → Splash → Start → App and logs out", async () => {
  const view = setup(false, "/unknown-route");
  expect(screen.getByText("Checking session…")).toHaveAttribute("role", "status");
  expect(view.mounted).not.toHaveBeenCalled();
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.getByTestId("location")).toHaveTextContent("/login");
  expect(screen.queryByText(/sign up/i)).toBeNull();
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "Internal" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Splash Screen" });
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  const login = view.fetcher.mock.calls.find(([url]) => url.endsWith("/auth/login"))![1]!;
  expect(login.credentials).toBe("include");
  expect(new Headers(login.headers).get("X-Requested-With")).toBe("SketchToSpec");
  fireEvent.click(screen.getByText("Continue"));
  expect(screen.getByRole("heading", { name: "Start Screen" })).toBeInTheDocument();
  fireEvent.click(screen.getByText("Continue"));
  expect(screen.getByRole("heading", { name: "App" })).toBeInTheDocument();
  fireEvent.click(screen.getByText("Logout"));
  await screen.findByRole("heading", { name: "Sign in" });
  const logout = view.fetcher.mock.calls.find(([url]) => url.endsWith("/auth/logout"))![1]!;
  expect(logout.credentials).toBe("include");
  expect(new Headers(logout.headers).get("X-CSRF-Token")).toBe("csrf-test");
  expect(screen.queryByText("App")).toBeNull();
});

it("shows a Google sign-in failure and removes the transient error query", async () => {
  setup(false, "/login?error=access_denied");
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.getByRole("alert")).toHaveTextContent("Google sign-in was not completed");
  expect(screen.getByTestId("location")).toHaveTextContent("/login");
});

it("restores a server session on refresh and returns to Login on a protected API 401", async () => {
  const view = setup(true, "/login");
  await screen.findByRole("heading", { name: "Splash Screen" });
  expect(view.fetcher.mock.calls.filter(([url]) => url.endsWith("/auth/login"))).toHaveLength(0);
  view.expire();
  await act(async () => { await apiFetch("/api/detect-floorplan", { method: "POST", body: new FormData() }); });
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.queryByText("Splash Screen")).toBeNull();
  const request = view.fetcher.mock.calls.find(([url]) => url.endsWith("/api/detect-floorplan"))![1]!;
  expect(request.credentials).toBe("include");
  expect(new Headers(request.headers).get("X-CSRF-Token")).toBe("csrf-test");
});

it("rechecks session validity on focus and fails closed when the backend is unavailable", async () => {
  const view = setup(true);
  await screen.findByRole("heading", { name: "Splash Screen" });
  view.offline(); fireEvent.focus(window);
  await screen.findByRole("heading", { name: "Sign in" });
  expect(screen.getByRole("alert")).toHaveTextContent("Unable to reach the sign-in service");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByText("Splash Screen")).toBeNull();
});

it("does not claim to log out if server revocation failed", async () => {
  const view = setup(true);
  await screen.findByRole("heading", { name: "Splash Screen" });
  view.failLogout(); fireEvent.click(screen.getByText("Logout"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Logout failed"));
  expect(screen.getByRole("heading", { name: "Splash Screen" })).toBeInTheDocument();
});
