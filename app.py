"""Railpack/Python build marker for the repository root.

This file is not part of the application and is never imported or executed.
It exists only so that Railway's Railpack builder detects this repository as a
Python application, which makes Railpack provision a Python interpreter before
the build command runs. Without a Python marker in the root directory Railpack
skips Python entirely and the build fails with "python: not found".

The FastAPI application lives in backend/ and is started with
`uvicorn main:app` from that directory (see railway.json).

A root-level marker is used instead of a root-level requirements.txt because
Railpack's pip mode creates a virtualenv at /app/.venv whenever a root
requirements.txt exists, and puts that venv ahead of the managed interpreter on
PATH. The real dependencies are installed from backend/requirements.txt by the
build command instead.

The Python version is pinned to 3.11 by the root .python-version file.
"""
