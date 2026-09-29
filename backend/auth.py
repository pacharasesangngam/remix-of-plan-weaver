"""Internal authentication. The browser holds an opaque, revocable session ID only."""
from __future__ import annotations

import hashlib
import asyncio
import hmac
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from authlib.integrations.starlette_client import OAuth
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=131072, r=8, p=1, maxmem=256 * 1024 * 1024).hex()
    return f"scrypt${salt}${digest}"


def valid_password_hash(value: str) -> bool:
    parts = value.split("$")
    try:
        return len(parts) == 3 and parts[0] == "scrypt" and len(bytes.fromhex(parts[1])) == 16 and len(bytes.fromhex(parts[2])) == 64
    except ValueError:
        return False


def verify_password(password: str, encoded: str) -> bool:
    return valid_password_hash(encoded) and hmac.compare_digest(password_hash(password, encoded.split("$")[1]), encoded)


@dataclass(frozen=True)
class AuthSettings:
    secret: str
    frontend_origin: str
    api_origin: str
    database: str
    secure: bool = True
    lifetime: int = 7 * 24 * 3600
    username: str = ""
    password: str = ""  # Encoded scrypt hash, never a plaintext password.
    google_id: str = ""
    google_secret: str = ""
    allowed_emails: frozenset[str] = frozenset()
    allowed_domains: frozenset[str] = frozenset()

    def __post_init__(self):
        if len(self.secret) < 32:
            raise ValueError("AUTH_SECRET must contain at least 32 random characters.")
        for origin in (self.frontend_origin, self.api_origin):
            url = urlsplit(origin)
            if url.scheme not in ("http", "https") or not url.netloc or url.path or url.query or url.fragment or url.username:
                raise ValueError("Auth origins must be exact HTTP(S) origins without paths.")
            if url.scheme != "https" and (self.secure or url.hostname not in ("localhost", "127.0.0.1", "::1")):
                raise ValueError("HTTP is only allowed on localhost with AUTH_COOKIE_SECURE=false.")
        if not self.secure and any(urlsplit(o).hostname not in ("localhost", "127.0.0.1", "::1") for o in (self.frontend_origin, self.api_origin)):
            raise ValueError("Secure cookies are required outside localhost.")
        if bool(self.username) != bool(self.password) or (self.password and not valid_password_hash(self.password)):
            raise ValueError("Set both AUTH_INTERNAL_USERNAME and a valid AUTH_INTERNAL_PASSWORD_HASH.")
        if not 60 <= self.lifetime <= 30 * 24 * 3600:
            raise ValueError("AUTH_SESSION_SECONDS must be between 60 seconds and 30 days.")

    @property
    def google_enabled(self):
        return bool(self.google_id and self.google_secret and (self.allowed_emails or self.allowed_domains))

    @classmethod
    def from_env(cls):
        items = lambda name: frozenset(v.strip().lower() for v in os.getenv(name, "").split(",") if v.strip())
        return cls(
            secret=os.getenv("AUTH_SECRET", ""), frontend_origin=os.getenv("AUTH_FRONTEND_ORIGIN", "http://localhost:8080").rstrip("/"),
            api_origin=os.getenv("AUTH_API_ORIGIN", "http://localhost:8000").rstrip("/"),
            database=os.getenv("AUTH_DB_PATH", str(Path(__file__).parent / ".data" / "auth.sqlite3")),
            secure=os.getenv("AUTH_COOKIE_SECURE", "true").lower() != "false",
            lifetime=int(os.getenv("AUTH_SESSION_SECONDS", "604800")), username=os.getenv("AUTH_INTERNAL_USERNAME", ""),
            password=os.getenv("AUTH_INTERNAL_PASSWORD_HASH", ""), google_id=os.getenv("GOOGLE_CLIENT_ID", ""),
            google_secret=os.getenv("GOOGLE_CLIENT_SECRET", ""), allowed_emails=items("GOOGLE_ALLOWED_EMAILS"), allowed_domains=items("GOOGLE_ALLOWED_DOMAINS"),
        )


class Auth:
    def __init__(self, settings: AuthSettings):
        self.settings = settings
        self.password_slots = asyncio.Semaphore(2)
        self.cookie = "__Host-sketch_session" if settings.secure else "sketch_session"
        Path(settings.database).parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)")
        self.oauth = OAuth()
        self.google = self.oauth.register(
            name="google", client_id=settings.google_id, client_secret=settings.google_secret,
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"},
        )

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.settings.database, timeout=10)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def csrf(self, token):
        return hmac.new(self.settings.secret.encode(), token.encode(), hashlib.sha256).hexdigest()

    def revision(self, provider):
        credential = self.settings.password if provider == "internal" else self.settings.google_id + "\0" + self.settings.google_secret
        return self.csrf(provider + credential)

    def google_allowed(self, user):
        email = str(user.get("email", "")).lower()
        domain = email.rsplit("@", 1)[-1]
        # Google's hosted-domain claim, not an email suffix alone, proves organization membership.
        return bool(user.get("sub") and user.get("email_verified") is True and "@" in email and (
            email in self.settings.allowed_emails or (domain in self.settings.allowed_domains and (user.get("hd") or "").lower() == domain)))

    def user(self, request):
        token = request.cookies.get(self.cookie, "")
        if not token or len(token) > 128:
            return None
        with self.db() as db:
            row = db.execute("SELECT user, expires FROM sessions WHERE id=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        if not row or row[1] <= time.time():
            return None
        user = json.loads(row[0])
        if user.get("revision") != self.revision(user["provider"]):
            return None
        if user["provider"] == "google" and (not self.settings.google_enabled or not self.google_allowed(user)):
            return None
        if user["provider"] == "internal" and user["name"] != self.settings.username:
            return None
        return user, row[1]

    def revoke(self, request):
        with self.db() as db:
            db.execute("DELETE FROM sessions WHERE id=?", (hashlib.sha256(request.cookies.get(self.cookie, "").encode()).hexdigest(),))

    def establish(self, request, response, user):
        self.revoke(request)
        token = secrets.token_urlsafe(32)
        user["revision"] = self.revision(user["provider"])
        with self.db() as db:
            db.execute("DELETE FROM sessions WHERE expires<=?", (int(time.time()),))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (hashlib.sha256(token.encode()).hexdigest(), json.dumps(user), int(time.time()) + self.settings.lifetime))
        response.set_cookie(self.cookie, token, max_age=self.settings.lifetime, secure=self.settings.secure, httponly=True, samesite="lax", path="/")
        return response

    def limited(self, request):
        # Deliberately ignore untrusted X-Forwarded-For. Configure Uvicorn's trusted proxy IPs when deployed.
        key = hashlib.sha256((request.client.host if request.client else "unknown").encode()).hexdigest()
        now = int(time.time())
        with self.db() as db:
            db.execute("DELETE FROM attempts WHERE expires<=?", (now,))
            db.execute("INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count=count+1", (key, now + 900))
            return db.execute("SELECT count FROM attempts WHERE key=?", (key,)).fetchone()[0] > 10


def install_auth(app: FastAPI, settings: AuthSettings | None = None) -> Auth:
    auth = Auth(settings or AuthSettings.from_env())
    app.state.auth = auth
    config = auth.settings
    public = {"/health", "/auth/session", "/auth/login", "/auth/google", "/auth/google/callback"}

    @app.middleware("http")
    async def gate(request: Request, call_next):
        user = auth.user(request)
        request.state.auth_user = user
        if request.method != "OPTIONS":
            if request.url.path not in public and user is None:
                return JSONResponse({"detail": "Authentication required."}, status_code=401, headers={"Cache-Control": "no-store"})
            if request.method not in ("GET", "HEAD"):
                if request.headers.get("origin") != config.frontend_origin:
                    return JSONResponse({"detail": "Untrusted request origin."}, status_code=403)
                if request.url.path == "/auth/login":
                    if request.headers.get("x-requested-with") != "SketchToSpec":
                        return JSONResponse({"detail": "Invalid login request."}, status_code=403)
                elif not user or not hmac.compare_digest(request.headers.get("x-csrf-token", "").encode(), auth.csrf(request.cookies.get(auth.cookie, "")).encode()):
                    return JSONResponse({"detail": "Invalid CSRF token."}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    app.add_middleware(SessionMiddleware, secret_key=config.secret, session_cookie="sketch_oauth", max_age=600, path="/auth", same_site="lax", https_only=config.secure)
    app.add_middleware(CORSMiddleware, allow_origins=[config.frontend_origin], allow_credentials=True,
                       allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allow_headers=["Content-Type", "X-CSRF-Token", "X-Requested-With"])

    @app.get("/auth/session")
    async def session(request: Request):
        current = request.state.auth_user
        user = current[0] if current else None
        return {"user": {"name": user["name"], "email": user.get("email"), "provider": user["provider"]} if user else None,
                "expiresAt": current[1] if current else None,
                "csrfToken": auth.csrf(request.cookies[auth.cookie]) if current else None,
                "internalEnabled": bool(config.username), "googleEnabled": config.google_enabled}

    @app.post("/auth/login")
    async def login(request: Request):
        if auth.limited(request):
            return JSONResponse({"detail": "Too many attempts. Try again in 15 minutes."}, status_code=429, headers={"Retry-After": "900"})
        try:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 8192:
                    return JSONResponse({"detail": "Login request is too large."}, status_code=413)
            payload = json.loads(body)
            username, password = payload.get("username"), payload.get("password")
            if not isinstance(username, str) or not isinstance(password, str) or len(username) > 200 or len(password) > 1024:
                raise ValueError()
        except (ValueError, AttributeError):
            return JSONResponse({"detail": "Invalid login request."}, status_code=400)
        if not config.username:
            return JSONResponse({"detail": "Internal login is unavailable."}, status_code=503)
        async with auth.password_slots:
            valid = await run_in_threadpool(verify_password, password, config.password)
        if not (valid and hmac.compare_digest(username.encode(), config.username.encode())):
            return JSONResponse({"detail": "Invalid username or password."}, status_code=401)
        request.session.clear()
        return auth.establish(request, JSONResponse({"ok": True}), {"provider": "internal", "name": config.username})

    @app.post("/auth/logout")
    async def logout(request: Request):
        auth.revoke(request)
        request.session.clear()
        response = JSONResponse({"ok": True})
        response.delete_cookie(auth.cookie, path="/", secure=config.secure, httponly=True, samesite="lax")
        return response

    @app.get("/auth/google")
    async def google_start(request: Request):
        if not config.google_enabled:
            return RedirectResponse(config.frontend_origin + "/login?error=google_unavailable", status_code=303)
        request.session.clear()
        try:
            return await auth.google.authorize_redirect(request, config.api_origin + "/auth/google/callback", prompt="select_account")
        except Exception:
            request.session.clear()
            return RedirectResponse(config.frontend_origin + "/login?error=google_unavailable", status_code=303)

    @app.get("/auth/google/callback")
    async def google_callback(request: Request):
        try:
            if not config.google_enabled:
                raise ValueError()
            # Authlib validates state, nonce, issuer, audience, expiry, and the signed ID token.
            token = await auth.google.authorize_access_token(request)
            identity = token.get("userinfo", {})
            if not auth.google_allowed(identity):
                raise ValueError()
            user = {key: identity.get(key) for key in ("sub", "email", "email_verified", "hd")}
            user.update(provider="google", name=identity.get("name") or identity["email"])
            response = auth.establish(request, RedirectResponse(config.frontend_origin + "/", status_code=303), user)
        except Exception:
            # Do not expose authorization codes, tokens, provider errors, or account details.
            response = RedirectResponse(config.frontend_origin + "/login?error=google_denied", status_code=303)
        request.session.clear()
        return response

    return auth
