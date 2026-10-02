"""Entry point: `uvicorn main:app`.

The application lives in the `coopledger` package; this shim exists so the
Dockerfile, docs, and anyone's existing process manager keep working unchanged.
"""
from coopledger.app import app  # noqa: F401
