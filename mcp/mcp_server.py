"""Read-only MCP tools for the Browserlink annotation inbox."""

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List

from mcp.server.fastmcp import FastMCP

VERSION = "1.0.0"
NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
mcp = FastMCP("browserlink")


def data_dir() -> Path:
    configured = os.environ.get("BROWSERLINK_DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return Path(hermes_home).expanduser() / "annotations"
    return Path.home() / ".browserlink" / "annotations"


def annotations_dir() -> Path:
    return data_dir() / "annotations"


def safe_name(name: str) -> bool:
    return bool(NAME_RE.match(name)) and "/" not in name and "\\" not in name and ".." not in name


def _files() -> List[Dict[str, Any]]:
    directory = annotations_dir()
    result = []
    if not directory.is_dir():
        return result
    for path in directory.iterdir():
        if not path.is_file() or path.suffix != ".json" or not safe_name(path.name):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        result.append({"name": path.name, "size": stat.st_size, "mtime": stat.st_mtime})
    result.sort(key=lambda item: item["mtime"], reverse=True)
    return result


@mcp.tool()
def hub_status() -> Dict[str, Any]:
    """Return Browserlink MCP status and resolved data directory."""
    adapters = []
    if all(os.environ.get(key) for key in ("HERMES_API_URL", "HERMES_API_KEY", "HERMES_SESSION_ID")):
        adapters.append("hermes")
    if os.environ.get("BROWSERLINK_WEBHOOK_URL"):
        adapters.append("webhook")
    return {"ok": True, "version": VERSION, "dataDir": str(data_dir()), "adapters": adapters}


@mcp.tool()
def annotations_list(limit: int = 20) -> List[Dict[str, Any]]:
    """List annotation files, newest first."""
    if limit < 0:
        raise ValueError("limit must be non-negative")
    return _files()[:limit]


@mcp.tool()
def annotations_latest() -> Dict[str, Any]:
    """Read the newest annotation, or return an empty object."""
    files = _files()
    if not files:
        return {}
    return annotations_get(files[0]["name"])


@mcp.tool()
def annotations_get(name: str) -> Dict[str, Any]:
    """Read one annotation by its safe file name."""
    if not safe_name(name):
        raise ValueError("invalid annotation name")
    path = annotations_dir() / name
    if not path.is_file():
        raise ValueError("annotation not found")
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError) as error:
        raise ValueError("annotation could not be read") from error
    if not isinstance(value, dict):
        raise ValueError("annotation must be an object")
    return value


@mcp.tool()
def annotations_watch(seconds: int = 10) -> List[str]:
    """Wait for new annotation files and return their names."""
    if seconds < 0:
        raise ValueError("seconds must be non-negative")
    before = {item["name"] for item in _files()}
    if seconds:
        time.sleep(seconds)
    after = [item["name"] for item in _files() if item["name"] not in before]
    return list(reversed(after))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
