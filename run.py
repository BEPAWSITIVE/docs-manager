import os
import sys
import time
import subprocess
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
NEXT_DIR = ROOT_DIR
NODE_DIR = Path(r"C:\Users\Deepak\.local\nodejs")

def run_all():
    print("=" * 65)
    print("  📁 Docs Manager (FastAPI Backend + Next.js Frontend)")
    print("=" * 65)
    print(f"Project Directory: {ROOT_DIR}")
    print("Backend URL:       http://127.0.0.1:8005")
    print("Frontend URL:      http://localhost:3000")
    print("=" * 65)

    # 1. Start FastAPI backend
    print("[1/2] Starting FastAPI backend on http://127.0.0.1:8005 ...")
    backend_proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8005",
            "--reload",
        ],
        cwd=str(ROOT_DIR),
    )

    time.sleep(2)

    # 2. Start Next.js frontend
    env = os.environ.copy()
    if NODE_DIR.exists():
        env["PATH"] = str(NODE_DIR) + os.pathsep + env.get("PATH", "")

    npm_cmd = str(NODE_DIR / "npm.cmd") if (NODE_DIR / "npm.cmd").exists() else "npm"

    print("[2/2] Starting Next.js frontend on http://localhost:3000 ...")
    frontend_proc = subprocess.Popen(
        [npm_cmd, "run", "dev"],
        cwd=str(NEXT_DIR),
        env=env,
    )

    try:
        frontend_proc.wait()
    except KeyboardInterrupt:
        print("\nStopping Docs Manager servers...")
        frontend_proc.terminate()
        backend_proc.terminate()
        frontend_proc.wait()
        backend_proc.wait()
        print("Shutdown complete.")

if __name__ == "__main__":
    run_all()
