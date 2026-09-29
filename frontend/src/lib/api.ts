export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
export const SESSION_EXPIRED = "sketch-session-expired";
let csrfToken: string | null = null;
export const setCsrfToken = (token: string | null) => { csrfToken = token; };

/** Cookies and the session's CSRF token accompany every application API request. */
export async function apiFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (!["GET", "HEAD"].includes((options.method || "GET").toUpperCase()) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers, credentials: "include" });
  if (response.status === 401) {
    setCsrfToken(null);
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  return response;
}
