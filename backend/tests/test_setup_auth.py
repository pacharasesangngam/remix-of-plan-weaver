import secrets
import tempfile
import unittest
from pathlib import Path
from dotenv import dotenv_values
from auth import verify_password
from setup_auth import create_local_env


class SetupAuthTests(unittest.TestCase):
    def test_stores_only_a_hash_and_never_overwrites_existing_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / ".env.example").write_text("AUTH_SECRET=\nAUTH_INTERNAL_USERNAME=\nAUTH_INTERNAL_PASSWORD_HASH=\nAUTH_COOKIE_SECURE=false\n", encoding="utf-8")
            password = secrets.token_urlsafe(24)
            path = create_local_env(directory, "internal", password)
            content = path.read_text(encoding="utf-8")
            self.assertNotIn(password, content)
            values = dotenv_values(path)
            self.assertGreaterEqual(len(values["AUTH_SECRET"]), 32)
            self.assertTrue(verify_password(password, values["AUTH_INTERNAL_PASSWORD_HASH"]))
            with self.assertRaises(FileExistsError): create_local_env(directory, "other", password)
            self.assertEqual(path.read_text(encoding="utf-8"), content)
