"""Tiny .env loader shared by the CannaBeats tools (no dependencies).

Looks for a .env file in, in order: the current working directory, the
CannaBeats project root (parent of tools/). Lines are KEY=VALUE; blank
lines and #-comments are ignored; values may be single- or double-quoted.
Real environment variables always win over .env values.
"""
import os
import pathlib


def load_dotenv() -> None:
    candidates = [
        pathlib.Path.cwd() / ".env",
        pathlib.Path(__file__).resolve().parent.parent / ".env",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip("'\"")
            os.environ.setdefault(key, value)
        return
