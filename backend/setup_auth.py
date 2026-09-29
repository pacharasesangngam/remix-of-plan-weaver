"""Create localhost authentication settings interactively without exposing a password."""
import json
import os
import secrets
from getpass import getpass
from pathlib import Path

from auth import password_hash


def create_local_env(directory: Path, username: str, password: str) -> Path:
    if not username.strip() or len(username) > 200 or not 12 <= len(password) <= 1024:
        raise ValueError("Enter a username and a password containing 12–1024 characters.")
    target = directory / ".env"
    if target.exists():
        raise FileExistsError(".env already exists. Update it using AUTH.md; it has not been overwritten.")
    values = {"AUTH_SECRET": secrets.token_urlsafe(48), "AUTH_INTERNAL_USERNAME": username.strip(),
              "AUTH_INTERNAL_PASSWORD_HASH": password_hash(password)}
    lines = (directory / ".env.example").read_text(encoding="utf-8").splitlines()
    content = "\n".join(f"{line.split('=', 1)[0]}={json.dumps(values[line.split('=', 1)[0]], ensure_ascii=False)}"
                        if line.split("=", 1)[0] in values else line for line in lines) + "\n"
    with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as file:
        file.write(content)
    return target


if __name__ == "__main__":
    directory = Path(__file__).resolve().parent
    if (directory / ".env").exists():
        raise SystemExit(".env already exists. See AUTH.md to update it.")
    username = input("Internal username: ").strip()
    password = getpass("Password (12–1024 characters): ")
    if password != getpass("Confirm password: "):
        raise SystemExit("Passwords do not match. No settings were written.")
    create_local_env(directory, username, password)
    print("Created backend/.env with a random secret and password hash. No plaintext password was stored.")
    print("Restart from backend: python -m uvicorn main:app --env-file .env --reload")
