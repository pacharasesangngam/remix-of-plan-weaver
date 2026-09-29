"""Run interactively; no password is accepted through shell arguments/history."""
from getpass import getpass
from auth import password_hash

if __name__ == "__main__":
    password = getpass("Internal account password (at least 12 characters): ")
    if not 12 <= len(password) <= 1024 or password != getpass("Confirm password: "):
        raise SystemExit("Passwords must match and contain 12–1024 characters.")
    print("AUTH_INTERNAL_PASSWORD_HASH=" + password_hash(password))
