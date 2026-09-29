import secrets
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from auth import AuthSettings, install_auth, password_hash


class AuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = secrets.token_urlsafe(20)
        cls.encoded = password_hash(cls.password)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = AuthSettings(secret=secrets.token_urlsafe(48), frontend_origin="https://app.example.test",
            api_origin="https://app.example.test", database=str(Path(self.temp.name) / "sessions.sqlite3"),
            username="test-internal", password=self.encoded)
        self.client, self.auth = self.make_app(self.settings)

    def make_app(self, settings):
        app = FastAPI()
        auth = install_auth(app, settings)

        @app.get("/health")
        def health(): return {"status": "ok"}

        @app.get("/api/private")
        @app.post("/api/detect-floorplan")
        def private(): return {"protected": True}

        client = TestClient(app, base_url="https://app.example.test", follow_redirects=False)
        self.addCleanup(client.close)
        return client, auth

    def login(self, **changes):
        return self.client.post("/auth/login", json={"username": self.settings.username, "password": self.password, **changes},
            headers={"Origin": self.settings.frontend_origin, "X-Requested-With": "SketchToSpec"})

    def mutation_headers(self):
        return {"Origin": self.settings.frontend_origin, "X-CSRF-Token": self.client.get("/auth/session").json()["csrfToken"]}

    def test_default_deny_protects_all_api_routes_and_docs(self):
        for path in ("/api/private", "/docs", "/openapi.json", "/new-api-route"):
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post("/api/detect-floorplan").status_code, 401)
        self.assertEqual(self.client.get("/health").json(), {"status": "ok"})
        self.assertIsNone(self.client.get("/auth/session").json()["user"])
        self.assertFalse(self.client.get("/auth/session").json()["googleEnabled"])

    def test_password_login_and_revoked_cookie_cannot_be_replayed(self):
        self.assertEqual(self.login(password=secrets.token_urlsafe(20)).status_code, 401)
        response = self.login()
        self.assertEqual(response.status_code, 200)
        cookie_header = response.headers["set-cookie"]
        for flag in ("HttpOnly", "Secure", "SameSite=lax", "Max-Age=604800", "__Host-sketch_session"):
            self.assertIn(flag, cookie_header)
        token = self.client.cookies.get(self.auth.cookie)
        with self.auth.db() as db:
            stored = db.execute("SELECT id, user FROM sessions").fetchone()
        self.assertNotIn(token, str(stored))
        self.assertNotIn(self.password, str(stored))
        self.assertEqual(self.client.get("/api/private").status_code, 200)
        self.assertEqual(self.client.post("/api/detect-floorplan", headers=self.mutation_headers()).status_code, 200)
        self.assertEqual(self.client.post("/auth/logout", headers=self.mutation_headers()).status_code, 200)
        self.assertEqual(self.client.get("/api/private", headers={"Cookie": f"{self.auth.cookie}={token}"}).status_code, 401)

    def test_csrf_and_exact_origin_are_required_including_login(self):
        data = {"username": self.settings.username, "password": self.password}
        self.assertEqual(self.client.post("/auth/login", json=data).status_code, 403)
        self.assertEqual(self.client.post("/auth/login", json=data, headers={"Origin": self.settings.frontend_origin}).status_code, 403)
        self.login()
        self.assertEqual(self.client.post("/api/detect-floorplan", headers={"Origin": self.settings.frontend_origin}).status_code, 403)
        headers = {**self.mutation_headers(), "Origin": "https://attacker.example.test"}
        self.assertEqual(self.client.post("/api/detect-floorplan", headers=headers).status_code, 403)
        self.assertEqual(self.client.post("/auth/logout", headers=headers).status_code, 403)
        response = self.client.options("/api/private", headers={"Origin": "https://attacker.example.test", "Access-Control-Request-Method": "GET"})
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_session_survives_restart_but_not_expiry_or_credential_rotation(self):
        self.login()
        token = self.client.cookies.get(self.auth.cookie)
        client, _ = self.make_app(self.settings)
        client.cookies.set(self.auth.cookie, token)
        self.assertEqual(client.get("/api/private").status_code, 200)
        rotated, _ = self.make_app(replace(self.settings, secret=secrets.token_urlsafe(48)))
        rotated.cookies.set(self.auth.cookie, token)
        self.assertEqual(rotated.get("/api/private").status_code, 401)
        with self.auth.db() as db: db.execute("UPDATE sessions SET expires=0")
        self.assertEqual(client.get("/api/private").status_code, 401)
        self.assertIsNone(client.get("/auth/session").json()["user"])

    def test_login_rotates_session_and_rate_limits_attempts(self):
        self.login()
        old = self.client.cookies.get(self.auth.cookie)
        self.login()
        self.assertNotEqual(old, self.client.cookies.get(self.auth.cookie))
        self.assertEqual(self.client.get("/api/private", headers={"Cookie": f"{self.auth.cookie}={old}"}).status_code, 401)
        # Invalid payloads count too, without requiring expensive hashes in this test.
        for _ in range(8): self.login(password=None)
        self.assertEqual(self.login().status_code, 429)

    def google_setup(self):
        settings = replace(self.settings, google_id="test-client", google_secret=secrets.token_urlsafe(16),
            allowed_emails=frozenset({"approved@gmail.com"}), allowed_domains=frozenset({"company.example"}))
        self.client, self.auth = self.make_app(settings)

    def test_google_rejects_missing_state_and_disallowed_or_unverified_claims(self):
        self.google_setup()
        self.assertIn("error=google_denied", self.client.get("/auth/google/callback?state=forged&code=forged").headers["location"])
        for identity in (
            {"sub": "1", "email": "outsider@elsewhere.example", "email_verified": True},
            {"sub": "1", "email": "approved@gmail.com", "email_verified": False},
            {"sub": "1", "email": "employee@company.example", "email_verified": True},
            {"sub": "1", "email": "employee@company.example", "email_verified": True, "hd": "other.example"},
        ):
            self.auth.google.authorize_access_token = AsyncMock(return_value={"userinfo": identity})
            response = self.client.get("/auth/google/callback")
            self.assertIn("error=google_denied", response.headers["location"])
            self.assertIsNone(self.client.get("/auth/session").json()["user"])

    def test_google_allowed_email_and_hosted_domain_establish_sessions_and_policy_changes_revoke(self):
        self.google_setup()
        for identity in (
            {"sub": "1", "email": "approved@gmail.com", "email_verified": True},
            {"sub": "2", "email": "Employee@company.example", "email_verified": True, "hd": "company.example"},
        ):
            self.auth.google.authorize_access_token = AsyncMock(return_value={"userinfo": identity})
            self.assertEqual(self.client.get("/auth/google/callback").headers["location"], self.settings.frontend_origin + "/")
            self.assertEqual(self.client.get("/api/private").status_code, 200)
            self.assertEqual(self.client.get("/auth/session").json()["user"]["provider"], "google")
        token = self.client.cookies.get(self.auth.cookie)
        denied, _ = self.make_app(replace(self.auth.settings, allowed_domains=frozenset()))
        denied.cookies.set(self.auth.cookie, token)
        self.assertEqual(denied.get("/api/private").status_code, 401)

    def test_google_redirect_uses_pkce_nonce_and_fixed_callback(self):
        self.google_setup()
        self.auth.google.load_server_metadata = AsyncMock(return_value={
            "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth"})
        response = self.client.get("/auth/google?next=https://attacker.example")
        from urllib.parse import parse_qs, urlsplit
        params = parse_qs(urlsplit(response.headers["location"]).query)
        self.assertEqual(params["redirect_uri"], [self.settings.api_origin + "/auth/google/callback"])
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertTrue(params["state"])
        self.assertTrue(params["nonce"])

    def test_google_provider_outage_returns_to_login_without_exposing_details(self):
        self.google_setup()
        self.auth.google.load_server_metadata = AsyncMock(side_effect=RuntimeError("private provider details"))
        response = self.client.get("/auth/google")
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], self.settings.frontend_origin + "/login?error=google_unavailable")
        self.assertNotIn("private provider details", response.text)

    def test_configuration_fails_closed(self):
        for changes in ({"secret": "short"}, {"password": "plaintext"}, {"secure": False}, {"frontend_origin": "*"}):
            with self.assertRaises(ValueError): replace(self.settings, **changes)

    def test_google_callback_verifies_signature_nonce_audience_issuer_and_expiry(self):
        from joserfc import jwt
        from joserfc.jwk import RSAKey
        from urllib.parse import parse_qs, urlsplit
        import time
        self.google_setup()
        key = RSAKey.generate_key(parameters={"kid": "test-key"})
        wrong_key = RSAKey.generate_key(parameters={"kid": "test-key"})
        self.auth.google.load_server_metadata = AsyncMock(return_value={
            "issuer": "https://accounts.google.com", "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
            "id_token_signing_alg_values_supported": ["RS256"],
        })
        self.auth.google.fetch_jwk_set = AsyncMock(return_value={"keys": [key.as_dict()]})
        for changes in ({}, {"nonce": "wrong"}, {"aud": "wrong"}, {"iss": "https://attacker.example"}, {"exp": 1}, {"bad_signature": True}):
            self.client.cookies.clear()
            start = self.client.get("/auth/google")
            params = parse_qs(urlsplit(start.headers["location"]).query)
            claims = {"iss": "https://accounts.google.com", "aud": "test-client", "sub": "approved-user",
                "email": "approved@gmail.com", "email_verified": True, "iat": int(time.time()), "exp": int(time.time()) + 300,
                "nonce": params["nonce"][0], **changes}
            signed = jwt.encode({"alg": "RS256", "kid": "test-key"}, claims, wrong_key if changes.get("bad_signature") else key)
            self.auth.google.fetch_access_token = AsyncMock(return_value={"access_token": "test-access", "id_token": signed})
            response = self.client.get("/auth/google/callback", params={"state": params["state"][0], "code": "test-code"})
            self.assertIn("code_verifier", self.auth.google.fetch_access_token.call_args.kwargs)
            self.assertEqual("error=google_denied" in response.headers["location"], bool(changes))
            self.assertEqual(self.client.get("/api/private").status_code, 401 if changes else 200)


if __name__ == "__main__": unittest.main()
