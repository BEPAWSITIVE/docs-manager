import os
from pathlib import Path

# Base Paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# On Vercel, the serverless filesystem is read-only except /tmp
if os.getenv("VERCEL"):
    STORAGE_DIR = Path("/tmp/storage")
else:
    STORAGE_DIR = PROJECT_ROOT / "storage"

DOCUMENTS_DIR = STORAGE_DIR / "documents"
METADATA_FILE = STORAGE_DIR / "metadata.json"

# Ensure storage directories exist
try:
    DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass

# Default Models
DEFAULT_MODEL = "gemini-flash-latest"
SUPPORTED_MODELS = [
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.5-pro",
]

# Supported file extensions (None means all formats accepted)
ALLOWED_EXTENSIONS = None

# API Config
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8005
BACKEND_URL = f"http://{BACKEND_HOST}:{BACKEND_PORT}"

KEY_FILE = STORAGE_DIR / "gemini_key.txt"


def get_api_key() -> str:
    """Reads persistent Gemini API key."""
    if KEY_FILE.exists():
        try:
            k = KEY_FILE.read_text(encoding="utf-8").strip()
            if k:
                return k
        except Exception:
            pass
    return os.getenv("GEMINI_API_KEY", "").strip()


def set_api_key(key: str) -> None:
    """Persists Gemini API key so it is never lost."""
    cleaned = key.strip()
    try:
        KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        KEY_FILE.write_text(cleaned, encoding="utf-8")
    except Exception:
        pass
    os.environ["GEMINI_API_KEY"] = cleaned
