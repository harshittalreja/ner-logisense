#!/usr/bin/env bash
# Start NER-LogiSense locally: http://localhost:8000 (dispatcher) and /driver (driver app)
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then python3 -m venv .venv; fi
source .venv/bin/activate
pip install -q -r requirements.txt
exec uvicorn backend.main:app --host 0.0.0.0 --port "${PORT:-8000}"
