# Internal authentication setup

The app is gated before Splash → Start → editor. There is no sign-up route or default account.
FastAPI requires authentication on all routes, including detection and API documentation,
except the minimal health check and sign-in/session/OAuth endpoints. React route protection
is a UI gate; the Python middleware enforces API authorization independently.

## Local setup

For first-time localhost setup, run `python setup_auth.py` from `backend`. It prompts for your
username/password without displaying the password and writes an ignored `.env` with a random
secret and password hash. It will not overwrite an existing `.env`. Restart the backend with
`python -m uvicorn main:app --env-file .env --reload`; a reloader process listening on port 8000
does not mean the application started successfully. Verify `/health` responds after startup.
The frontend bounds session checks to ten seconds and shows Login with Retry if the API stalls.

1. In `backend`, install `python -m pip install -r requirements.txt` in your backend virtual environment.
2. Copy `.env.example` to `.env`. This file is ignored by Git. Generate a random `AUTH_SECRET`
   using the command in the example. Set an internal username and run `python hash_password.py`.
   Paste the resulting **hash** into `AUTH_INTERNAL_PASSWORD_HASH`; never store the password itself.
3. Run `python -m uvicorn main:app --env-file .env --host 127.0.0.1 --port 8000`.
4. In `frontend`, leave `VITE_API_BASE_URL` empty (remove old overrides pointing elsewhere), then
   run `npm run dev`. Open `http://localhost:8080`. Vite proxies `/auth` and `/api` to Python.

Missing/weak `AUTH_SECRET`, invalid password hashes, or insecure non-local origins fail startup.
If neither provider is configured, no one can sign in. No environment configuration disables the gate.

## Google

Create a Google OAuth **Web application** client, configure the consent screen, and set the client
ID and secret in the **backend** environment. Register this exact local redirect URI:
`http://localhost:8080/auth/google/callback`. If the Google consent screen is in testing mode,
also add your users as Google OAuth test users.

Set `GOOGLE_ALLOWED_EMAILS` to comma-separated exact verified email addresses and/or
`GOOGLE_ALLOWED_DOMAINS` to exact Google Workspace hosted domains, without `@` or wildcards.
There is no default company domain. Domain access requires both a matching email domain and
Google's signed `hd` organization claim. An exact email allowlist also supports individual Google
accounts. Empty allowlists deny everyone and hide Google sign-in. Changes take effect on restart
and are checked against existing sessions on every request.

The server uses Authlib's authorization-code flow with PKCE and validates Google's signed ID token,
state, nonce, issuer, audience, and expiration. Google access/refresh tokens are not stored or sent
to the frontend. Configure production redirect URI as `AUTH_API_ORIGIN/auth/google/callback`.
Reference: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
and [Authlib Starlette integration](https://docs.authlib.org/en/latest/client/starlette.html).

## Deployment

Use HTTPS and `AUTH_COOKIE_SECURE=true`. Set exact HTTPS origins in `AUTH_FRONTEND_ORIGIN` and
`AUTH_API_ORIGIN`, and keep all secrets in the server platform's secret/environment settings.
Never put auth secrets or password hashes in `VITE_*` variables.

The simplest deployment serves the frontend and proxies `/api/*` and `/auth/*` to FastAPI on
the **same public origin**. Both auth origins should then be that public origin and the frontend
API base should be empty. Proxy these paths before the SPA fallback, preserving `Origin`, cookies,
`Set-Cookie`, and redirect responses. Alternatively use sibling HTTPS custom domains such as
`app.example.com` and `api.example.com`; set `VITE_API_BASE_URL` and `AUTH_API_ORIGIN` to the API origin.

The existing generic Vercel SPA rewrite alone does not proxy APIs. A `vercel.app` frontend calling a
`railway.app` backend is cross-site and will not work with these SameSite=Lax cookies. Configure a
same-origin reverse proxy or same-site custom domains before deployment; do not weaken the cookies
to work around third-party-cookie blocking.

Mount a persistent volume and set `AUTH_DB_PATH` to its `auth.sqlite3` path. SQLite is intended for a
single backend instance (multiple workers on the same instance can share it). Replicas need a shared
session/rate-limit store before scaling. Restrict database and environment-file access to the service
account. If behind a proxy, configure Uvicorn's trusted forwarded IPs for that proxy only; never trust
arbitrary client-supplied `X-Forwarded-For`. Password login is limited to ten attempts per IP per 15 minutes.

Sessions last seven days by default (`AUTH_SESSION_SECONDS`), survive refresh/backend restart,
and use opaque random IDs in HttpOnly, SameSite=Lax cookies (Secure and `__Host-` prefixed on HTTPS).
Only hashed session IDs are stored in SQLite. Logout revokes the server session; expiration and
credential/secret changes invalidate it. Unsafe requests require an exact allowed Origin and a
session-bound CSRF token; password login requires an additional custom request header.
The frontend checks sessions on load, window focus, every minute, and on API 401 responses.

Tests: `python -m unittest discover -s tests` from `backend`. These use a minimal FastAPI app and a
temporary session database, without loading YOLO. Google tests use local signing keys and mocked
provider HTTP responses to exercise token verification; a live Google redirect still requires your
OAuth credentials and a browser smoke test.
