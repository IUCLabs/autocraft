import os
import sqlite3
from pathlib import Path

DEFAULT_DB = Path.home() / ".local/share/craft-automation/mirror.db"


def db_path() -> Path:
    return Path(os.environ.get("CRAFT_AUTO_DB", DEFAULT_DB))


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    # WAL so the dashboard can read while a sync writes
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript((Path(__file__).parent / "schema.sql").read_text())
    return conn
