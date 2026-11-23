"""Vercel Python Function WSGI entrypoint (project root: backend)."""
from app import create_app

# Enforce cloud protection even if automatic Vercel environment variables are disabled.
# Passing explicit configuration also prevents loading a local .env in this entrypoint.
app = create_app({"VERCEL": "1"})
