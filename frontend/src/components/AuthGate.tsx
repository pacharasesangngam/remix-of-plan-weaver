import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL, apiFetch, SESSION_EXPIRED, setCsrfToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogOut, PencilRuler } from "lucide-react";

interface Session {
  user: { name: string; email?: string; provider: string } | null;
  csrfToken: string | null;
  expiresAt: number | null;
  internalEnabled: boolean;
  googleEnabled: boolean;
}
interface AuthState {
  session: Session | null; loading: boolean; error: string;
  refresh: () => Promise<void>; login: (username: string, password: string) => Promise<void>; logout: () => Promise<void>;
}
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pendingCheck = useRef<{ controller: AbortController; timer: number } | null>(null);
  const queries = useQueryClient();
  const cancelCheck = useCallback(() => {
    const pending = pendingCheck.current;
    pendingCheck.current = null;
    if (pending) { clearTimeout(pending.timer); pending.controller.abort(); }
  }, []);
  const clear = useCallback(() => {
    generation.current++;
    cancelCheck();
    setCsrfToken(null);
    setSession(current => current ? { ...current, user: null, csrfToken: null, expiresAt: null } : null);
    queries.clear();
  }, [queries, cancelCheck]);
  const refresh = useCallback(async () => {
    setError("");
    // Focus events and polling share a single request and its original deadline.
    if (pendingCheck.current) return;
    const current = ++generation.current;
    const controller = new AbortController();
    // Every path out of this request must release the pending slot exactly once.
    // Otherwise a check that never settles keeps the slot, and later retries
    // silently return instead of re-running.
    let settled = false;
    const release = () => {
      if (settled) return false;
      settled = true;
      if (pendingCheck.current?.controller === controller) pendingCheck.current = null;
      return true;
    };
    // A superseded check only keeps its own result; a newer pending check owns
    // the UI, so the loading state must not be released underneath it.
    const fail = (message: string) => {
      if (current !== generation.current && pendingCheck.current) return;
      clear(); setError(message); setLoading(false);
    };
    const timer = window.setTimeout(() => {
      if (!release()) return;
      controller.abort();
      fail("The sign-in service did not respond. Please retry.");
    }, 10000);
    pendingCheck.current = { controller, timer };
    try {
      const response = await fetch(`${API_BASE_URL}/auth/session`, { credentials: "include", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error();
      const next: Session = await response.json();
      if (current !== generation.current) return;
      setCsrfToken(next.csrfToken); setSession(next); setError("");
      if (!next.user) queries.clear();
      setLoading(false);
    } catch {
      // The watchdog already released and reported this attempt.
      if (settled) return;
      if (current !== generation.current && pendingCheck.current) return;
      clear(); setError("Unable to reach the sign-in service. Please retry.");
      setLoading(false);
    } finally {
      release();
      clearTimeout(timer);
    }
  }, [clear, queries]);
  useEffect(() => {
    void refresh();
    const expired = () => { clear(); setLoading(false); };
    const focused = () => { void refresh(); };
    const hidden = () => { generation.current++; cancelCheck(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) { hidden(); void refresh(); } };
    window.addEventListener(SESSION_EXPIRED, expired);
    window.addEventListener("focus", focused);
    window.addEventListener("pagehide", hidden);
    window.addEventListener("pageshow", restored);
    const timer = window.setInterval(focused, 60000);
    return () => { hidden(); clearInterval(timer); window.removeEventListener(SESSION_EXPIRED, expired); window.removeEventListener("focus", focused); window.removeEventListener("pagehide", hidden); window.removeEventListener("pageshow", restored); };
  }, [refresh, clear, cancelCheck]);
  useEffect(() => {
    if (!session?.expiresAt) return;
    const deadline = session.expiresAt * 1000;
    let timer: number;
    const schedule = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) clear();
      else timer = window.setTimeout(schedule, Math.min(remaining, 2147483647));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [session?.expiresAt, clear]);
  const login = async (username: string, password: string) => {
    setError("");
    generation.current++;
    cancelCheck();
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "X-Requested-With": "SketchToSpec" },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) throw new Error(response.status === 429 ? "Too many attempts. Try again in 15 minutes." : "Unable to sign in. Check your username and password.");
    cancelCheck();
    await refresh();
  };
  const logout = async () => {
    generation.current++;
    cancelCheck();
    const response = await apiFetch("/auth/logout", { method: "POST" });
    if (!response.ok && response.status !== 401) throw new Error("Logout failed. Please try again.");
    clear();
  };
  return <AuthContext.Provider value={{ session, loading, error, refresh, login, logout }}>{children}</AuthContext.Provider>;
}

function Login() {
  const auth = useContext(AuthContext)!;
  const location = useLocation();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [googleError, setGoogleError] = useState(() => new URLSearchParams(location.search).has("error") ? "Google sign-in was not completed or this account is not allowed." : "");
  useEffect(() => {
    if (!googleError) return;
    setGoogleError("");
    navigate({ pathname: location.pathname, hash: location.hash }, { replace: true });
  }, [googleError, location.hash, location.pathname, navigate]);
  return <main className="flex min-h-screen items-center justify-center bg-background bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_65%)] p-6">
    <section className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm">
      {/* <div className="mb-6 flex items-center gap-3"><span className="rounded-xl bg-primary/10 p-3 text-primary"><PencilRuler className="h-6 w-6" /></span><span className="font-semibold tracking-tight">Sign in</span></div> */}
      <h1 className="text-2xl font-semibold tracking-tight pb-5 text-center">Sign in</h1>
      {auth.session?.internalEnabled && <form className="space-y-4" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError("");
        try { await auth.login(username, password); } catch (error) { setError(error instanceof Error ? error.message : "Unable to sign in."); }
        finally { setPassword(""); setBusy(false); }
      }}>
        <label className="block text-sm font-medium">Username<Input autoComplete="username" value={username} maxLength={200} required disabled={busy} onChange={e => setUsername(e.target.value)} className="mt-2" /></label>
        <label className="block text-sm font-medium">Password<Input type="password" autoComplete="current-password" value={password} maxLength={1024} required disabled={busy} onChange={e => setPassword(e.target.value)} className="mt-2" /></label>
        <Button type="submit" disabled={busy} className="w-full">{busy ? "Signing in…" : "Sign in"}</Button>
      </form>}
      <div className="mt-4 flex items-center gap-6 text-xs font-medium text-muted-foreground">
        <div className="h-px flex-1 bg-border" /><span>or</span><div className="h-px flex-1 bg-border" />
      </div>
      {auth.session?.googleEnabled && <Button variant="outline" disabled={busy} className="mt-4 w-full" onClick={() => { window.location.assign(`${API_BASE_URL}/auth/google`); }}><svg aria-hidden="true" className="mr-2 h-4 w-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M21.35 12.27c0-.71-.06-1.4-.18-2.05H12v3.88h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.14c1.84-1.69 2.91-4.18 2.91-7.22Z"/><path fill="#34A853" d="M12 21.75c2.63 0 4.84-.87 6.45-2.36l-3.14-2.45c-.87.58-1.98.92-3.31.92-2.54 0-4.69-1.72-5.46-4.03H3.3v2.53A9.75 9.75 0 0 0 12 21.75Z"/><path fill="#FBBC05" d="M6.54 13.83A5.86 5.86 0 0 1 6.23 12c0-.64.11-1.26.31-1.83V7.64H3.3A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.06 1.05 4.36l3.24-2.53Z"/><path fill="#EA4335" d="M12 6.14c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.84 3.13 14.63 2.25 12 2.25A9.75 9.75 0 0 0 3.3 7.64l3.24 2.53c.77-2.31 2.92-4.03 5.46-4.03Z"/></svg>Continue with Google</Button>}
      {(error || auth.error || googleError) && <p role="alert" className="mt-4 text-sm text-destructive">{error || auth.error || googleError}</p>}
      {auth.session && !auth.session.internalEnabled && !auth.session.googleEnabled && <p role="alert" className="text-sm text-muted-foreground">Sign-in is not configured. Contact your administrator.</p>}
      {/* <p className="mt-6 text-xs text-muted-foreground">Access is limited to approved accounts. Contact your administrator for access.</p> */}
    </section>
  </main>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useContext(AuthContext)!;
  const location = useLocation();
  if (auth.loading) return <div role="status" className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Checking session…</div>;
  if (!auth.session?.user) return location.pathname === "/login" ? <Login /> : <Navigate to="/login" replace />;
  if (location.pathname === "/login") return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function LogoutButton() {
  const auth = useContext(AuthContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!auth?.session?.user) return null;
  return <><button type="button" disabled={busy} onClick={async () => {
    setBusy(true); setError("");
    try { await auth.logout(); } catch { setError("Logout failed. Please try again."); } finally { setBusy(false); }
  }} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"><LogOut className="h-3.5 w-3.5" />{busy ? "Signing out…" : "Logout"}</button>
    {error && <span role="alert" className="text-xs text-destructive">{error}</span>}</>;
}
