import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
TTS_MODEL = os.environ.get("TTS_MODEL", "gpt-4o-mini-tts")
STT_MODEL = os.environ.get("STT_MODEL", "gpt-4o-mini-transcribe")

# Text generation (persona/coach/synthesis agents) — Gemini if configured, else OpenAI.
# Audio (speech-to-text/text-to-speech) still runs on OpenAI either way; see audio.py.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
LLM_MODEL = os.environ.get("LLM_MODEL") or (
    f"google:{GEMINI_MODEL}" if GEMINI_API_KEY else "openai:gpt-5.4-mini"
)
LIVEAVATAR_API_KEY = os.environ.get("LIVEAVATAR_API_KEY", "")
LIVEAVATAR_AVATAR_ID = os.environ.get("LIVEAVATAR_AVATAR_ID", "")
LIVEAVATAR_API_URL = os.environ.get("LIVEAVATAR_API_URL", "https://api.liveavatar.com").rstrip("/")
LIVEAVATAR_SANDBOX = os.environ.get("LIVEAVATAR_SANDBOX", "true").lower() in {"1", "true", "yes"}
CANDIDATE_CUSTOMER_COUNT = int(os.environ.get("CANDIDATE_CUSTOMER_COUNT", "3"))
CANDIDATE_INVESTOR_COUNT = int(os.environ.get("CANDIDATE_INVESTOR_COUNT", "2"))

if not OPENAI_API_KEY:
    raise RuntimeError(
        "OPENAI_API_KEY is not set. Copy backend/.env.example to backend/.env "
        "and fill in your key."
    )
