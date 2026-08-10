"""Read-only MCP tools for the Browserlink annotation inbox, plus connect tools."""

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP

VERSION = "1.3.0"
NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
DEFAULT_HUB = "http://127.0.0.1:8787"
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


def hub_base() -> str:
    configured = os.environ.get("BROWSERLINK_HUB_URL")
    if configured:
        return configured.rstrip("/")
    return DEFAULT_HUB


def _hub_request(method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = hub_base() + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=data, method=method, headers=headers)
    try:
        with urlopen(request, timeout=5) as response:
            raw = response.read().decode("utf-8")
            if not raw:
                return {"ok": True}
            value = json.loads(raw)
            if isinstance(value, dict):
                return value
            return {"ok": True, "data": value}
    except HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode("utf-8")
            parsed = json.loads(detail)
            if isinstance(parsed, dict) and parsed.get("error"):
                return {"ok": False, "error": str(parsed["error"]), "status": error.code}
        except (OSError, ValueError, UnicodeDecodeError):
            pass
        return {"ok": False, "error": detail or str(error), "status": error.code}
    except (URLError, OSError, ValueError) as error:
        return {"ok": False, "error": str(error)}


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
    if all(os.environ.get(key) for key in ("HERMES_API_URL", "HERMES_API_KEY")):
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


@mcp.tool()
def browserlink_connect(sessionId: str, label: str = "", activate: bool = True) -> Dict[str, Any]:
    """Connect this chat as the annotation delivery target and optionally activate the extension."""
    if not isinstance(sessionId, str) or not sessionId:
        return {"ok": False, "error": "sessionId must be a non-empty string"}
    if len(sessionId) > 200:
        return {"ok": False, "error": "sessionId must be at most 200 characters"}
    if not isinstance(label, str):
        return {"ok": False, "error": "label must be a string"}
    if len(label) > 200:
        return {"ok": False, "error": "label must be at most 200 characters"}
    if not isinstance(activate, bool):
        return {"ok": False, "error": "activate must be a boolean"}

    target_result = _hub_request("POST", "/target", {
        "sessionId": sessionId,
        "label": label,
        "activate": activate,
    })
    if not target_result.get("ok"):
        return {
            "ok": False,
            "error": target_result.get("error", "POST /target failed"),
            "sessionId": sessionId,
            "label": label,
            "activate": activate,
        }

    if activate:
        activate_result = _hub_request("POST", "/activate", {"active": True})
        if not activate_result.get("ok"):
            return {
                "ok": False,
                "error": activate_result.get("error", "POST /activate failed"),
                "sessionId": sessionId,
                "label": label,
                "activate": activate,
            }

    return {"ok": True, "sessionId": sessionId, "label": label, "activate": activate}


@mcp.tool()
def browserlink_disconnect() -> Dict[str, Any]:
    """Clear the connected chat target so annotations are no longer delivered there."""
    result = _hub_request("POST", "/target", {
        "sessionId": "",
        "label": "",
        "activate": False,
    })
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error", "disconnect failed")}
    return {"ok": True}


@mcp.tool()
def browserlink_status() -> Dict[str, Any]:
    """Return hub /status merged with the current /target (or null target)."""
    status = _hub_request("GET", "/status")
    if status.get("ok") is False and "error" in status and "version" not in status:
        return status
    target = _hub_request("GET", "/target")
    if target.get("ok") is False and target.get("status") == 404:
        status["target"] = None
    elif target.get("ok") is False and "error" in target and "sessionId" not in target:
        # Network/other failure; still return status with target null.
        status["target"] = None
        status["targetError"] = target.get("error")
    else:
        status["target"] = {
            "sessionId": target.get("sessionId", ""),
            "label": target.get("label", ""),
            "activate": target.get("activate", False),
            "ts": target.get("ts"),
        }
    if "ok" not in status:
        status["ok"] = True
    return status


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
