@echo off
REM Start NER-LogiSense locally: http://localhost:8000 (dispatcher) and /driver (driver app)
cd /d %~dp0
if not exist .venv python -m venv .venv
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 8000
