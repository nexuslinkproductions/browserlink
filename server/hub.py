#!/usr/bin/env python3
"""Local HTTP bridge for the Comet annotation extension."""

import argparse
import base64
import json
import logging
import math
import os
import re
import tempfile
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, cast
from urllib.parse import urlsplit

from adapters import hermes, webhook


LOGGER = logging.getLogger(__name__)


HOST = "127.0.0.1"
DEFAULT_PORT = 8787
VERSION = "1.0.0"
NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
SCREENSHOT_PREFIX = "data:image/png;base64,"
MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024

# Schema v1.5: allowed keys for elements[].edits (protocol, docs/protocol.md).
ALLOWED_EDIT_KEYS = frozenset((
    "width", "height", "fontFamily", "fontSize", "fontWeight", "lineHeight",
    "color", "backgroundColor", "text", "href", "display", "margin",
    "padding", "borderRadius",
    "textAlign", "textTransform", "letterSpacing", "wordSpacing", "whiteSpace",
    "verticalAlign", "textDecoration", "fontStyle", "textShadow",
))


def data_dir() -> Path:
    configured = os.environ.get("BROWSERLINK_DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return Path(hermes_home).expanduser() / "annotations"
    return Path.home() / ".browserlink" / "annotations"


def annotations_dir() -> str:
    return str(data_dir() / "annotations")


def target_path() -> Path:
    return data_dir() / "target.json"


def is_safe_name(name: str) -> bool:
    return bool(NAME_RE.match(name)) and "/" not in name and "\\" not in name and ".." not in name


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    directory = path.parent
    os.makedirs(directory, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=str(directory),
                                     prefix=".target-", suffix=".tmp", delete=False) as temp_file:
        temp_path = temp_file.name
        json.dump(payload, temp_file, ensure_ascii=False, indent=2)
        temp_file.write("\n")
        temp_file.flush()
        os.fsync(temp_file.fileno())
    os.replace(temp_path, str(path))


def read_target() -> Optional[Dict[str, Any]]:
    path = target_path()
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    return value


def clear_target() -> None:
    path = target_path()
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def atomic_write_bytes(path: Path, data: bytes) -> None:
    directory = path.parent
    os.makedirs(directory, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="wb", dir=str(directory),
                                     prefix=".annotation-", suffix=".tmp", delete=False) as temp_file:
        temp_path = temp_file.name
        temp_file.write(data)
        temp_file.flush()
        os.fsync(temp_file.fileno())
    os.replace(temp_path, str(path))


def store_annotation(payload: Dict[str, Any]) -> Path:
    """Persist annotation JSON; optional screenshot becomes a sibling PNG.

    When payload contains a validated ``screenshot`` data URL, decode it to
    ``<timestamp>.png`` beside the JSON and store ``screenshotFile`` instead of
    the base64 blob. Payloads without ``screenshot`` are written unchanged.
    """
    directory = annotations_dir()
    os.makedirs(directory, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]

    stored: Dict[str, Any] = {key: value for key, value in payload.items() if key != "screenshot"}
    screenshot = payload.get("screenshot")
    if isinstance(screenshot, str) and screenshot.startswith(SCREENSHOT_PREFIX):
        png_name = timestamp + ".png"
        png_path = Path(directory) / png_name
        raw = base64.b64decode(screenshot[len(SCREENSHOT_PREFIX):], validate=True)
        atomic_write_bytes(png_path, raw)
        stored["screenshotFile"] = png_name

    path = Path(directory) / (timestamp + ".json")
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                     prefix=".annotation-", suffix=".tmp", delete=False) as temp_file:
        temp_path = temp_file.name
        json.dump(stored, temp_file, ensure_ascii=False, indent=2)
        temp_file.write("\n")
        temp_file.flush()
        os.fsync(temp_file.fileno())
    os.replace(temp_path, str(path))

    # Expose the on-disk shape to callers (e.g. adapters).
    payload.clear()
    payload.update(stored)
    return path


def _dispatch_adapter(
    register_fn: Callable[..., None],
    annotation: Dict[str, Any],
    path: Path,
) -> None:
    """Call adapter with annotation path when supported; else annotation only."""
    try:
        register_fn(annotation, str(path))
    except TypeError:
        register_fn(annotation)


ADAPTERS = []


def reload_adapters() -> None:
    global ADAPTERS
    ADAPTERS = []
    # Session may come from target.json; only API URL + key are required to load.
    if all(os.environ.get(key) for key in ("HERMES_API_URL", "HERMES_API_KEY")):
        ADAPTERS.append(("hermes", hermes.register))
    if os.environ.get("BROWSERLINK_WEBHOOK_URL"):
        ADAPTERS.append(("webhook", webhook.register))


def status_payload() -> Dict[str, Any]:
    target = read_target()
    target_summary = None
    if target is not None:
        session_id = target.get("sessionId")
        if isinstance(session_id, str) and session_id:
            target_summary = {
                "sessionId": session_id,
                "label": target.get("label", "") if isinstance(target.get("label"), str) else "",
            }
    return {
        "ok": True,
        "version": VERSION,
        "dataDir": str(data_dir()),
        "adapters": [name for name, _ in ADAPTERS],
        "target": target_summary,
    }


reload_adapters()


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(cast(float, value))


def validate_payload(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return "payload must be a JSON object"
    if not isinstance(payload.get("source"), str):
        return "source must be a string"
    if not isinstance(payload.get("url"), str):
        return "url must be a string"

    title = payload.get("title")
    if title is not None and not isinstance(title, str):
        return "title must be a string"

    viewport = payload.get("viewport")
    if not isinstance(viewport, dict):
        return "viewport must be an object"
    for key in ("w", "h"):
        value = viewport.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            return "viewport.%s must be a positive integer" % key

    strokes = payload.get("strokes")
    if not isinstance(strokes, list):
        return "strokes must be a list"
    for stroke_index, stroke in enumerate(strokes):
        if not isinstance(stroke, dict):
            return "strokes[%d] must be an object" % stroke_index
        if not isinstance(stroke.get("color"), str):
            return "strokes[%d].color must be a string" % stroke_index
        width = stroke.get("width")
        if not is_number(width) or float(width) <= 0:
            return "strokes[%d].width must be a positive number" % stroke_index
        points = stroke.get("points")
        if not isinstance(points, list) or len(points) < 2:
            return "strokes[%d].points must contain at least two points" % stroke_index
        for point_index, point in enumerate(points):
            if (not isinstance(point, list) or len(point) != 2 or
                    not is_number(point[0]) or not is_number(point[1]) or
                    not 0 <= float(point[0]) <= 1 or not 0 <= float(point[1]) <= 1):
                return "strokes[%d].points[%d] must be [x,y] with values from 0 to 1" % (stroke_index, point_index)

    elements = payload.get("elements")
    if elements is not None:
        if not isinstance(elements, list):
            return "elements must be a list"
        for element_index, element in enumerate(elements):
            if not isinstance(element, dict):
                return "elements[%d] must be an object" % element_index
            index = element.get("index")
            if not isinstance(index, int) or isinstance(index, bool):
                return "elements[%d].index must be an integer" % element_index
            if len(element) < 2:
                return "elements[%d] must include at least one key besides index" % element_index
            edits = element.get("edits")
            if edits is not None:
                if not isinstance(edits, dict):
                    return "elements[%d].edits must be an object" % element_index
                for key, value in edits.items():
                    if key not in ALLOWED_EDIT_KEYS:
                        return "elements[%d].edits has unknown key '%s'" % (element_index, key)
                    if not isinstance(value, str):
                        return "elements[%d].edits.%s must be a string" % (element_index, key)

    label = payload.get("label")
    if label is not None:
        if not isinstance(label, str):
            return "label must be a string"
        if len(label) > 200:
            return "label must be at most 200 characters"

    # Schema v1.4: optional screenshot data URL (PNG base64).
    if "screenshot" in payload:
        screenshot = payload.get("screenshot")
        if not isinstance(screenshot, str):
            return "screenshot must be a string"
        if not screenshot.startswith(SCREENSHOT_PREFIX):
            return "screenshot must be a data:image/png;base64, data URL"
        try:
            raw = base64.b64decode(screenshot[len(SCREENSHOT_PREFIX):], validate=True)
        except Exception:
            return "screenshot must be valid base64 PNG data"
        if len(raw) > MAX_SCREENSHOT_BYTES:
            return "screenshot exceeds 10MB decoded size"
    return None


def validate_target_body(payload: Any) -> Tuple[Optional[str], Optional[str]]:
    """Validate POST /target. Returns (error, mode) where mode is 'set' or 'clear'."""
    if not isinstance(payload, dict):
        return "payload must be a JSON object", None
    session_id = payload.get("sessionId", "")
    if session_id is None:
        session_id = ""
    if not isinstance(session_id, str):
        return "sessionId must be a string", None
    activate = payload.get("activate")
    # Disconnect/clear: empty sessionId with activate explicitly false.
    if session_id == "" and activate is False:
        return None, "clear"
    if session_id == "":
        return "sessionId must be a non-empty string", None
    if len(session_id) > 200:
        return "sessionId must be at most 200 characters", None
    label = payload.get("label", "")
    if label is None:
        label = ""
    if not isinstance(label, str):
        return "label must be a string", None
    if len(label) > 200:
        return "label must be at most 200 characters", None
    if activate is not None and not isinstance(activate, bool):
        return "activate must be a boolean", None
    return None, "set"


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _read_json_body(handler: BaseHTTPRequestHandler) -> Tuple[Optional[Any], Optional[str]]:
    try:
        length = int(handler.headers.get("Content-Length", "-1"))
        raw = handler.rfile.read(length)
        return json.loads(raw.decode("utf-8")), None
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None, "invalid JSON"


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "CometAnnotationBridge/1.0"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, status: int, value: Any) -> None:
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_OPTIONS(self) -> None:
        self.send_empty(204)

    def do_POST(self) -> None:
        status = 500
        path = urlsplit(self.path).path
        try:
            if path == "/target":
                payload, err = _read_json_body(self)
                if err is not None:
                    status = 400
                    self.send_json(status, {"error": err})
                    return
                error, mode = validate_target_body(payload)
                if error is not None:
                    status = 400
                    self.send_json(status, {"error": error})
                    return
                if mode == "clear":
                    clear_target()
                    status = 200
                    self.send_json(status, {"ok": True})
                    return
                assert isinstance(payload, dict)
                label = payload.get("label", "")
                if label is None:
                    label = ""
                activate = payload.get("activate", False)
                if activate is None:
                    activate = False
                record = {
                    "sessionId": payload["sessionId"],
                    "label": label,
                    "ts": int(datetime.now().timestamp() * 1000),
                    "activate": bool(activate),
                }
                atomic_write_json(target_path(), record)
                status = 200
                self.send_json(status, {"ok": True})
                return

            if path == "/activate":
                payload, err = _read_json_body(self)
                if err is not None:
                    status = 400
                    self.send_json(status, {"error": err})
                    return
                if not isinstance(payload, dict):
                    status = 400
                    self.send_json(status, {"error": "payload must be a JSON object"})
                    return
                active = payload.get("active")
                if not isinstance(active, bool):
                    status = 400
                    self.send_json(status, {"error": "active must be a boolean"})
                    return
                existing = read_target() or {}
                record = {
                    "sessionId": existing.get("sessionId", "") if isinstance(existing.get("sessionId"), str) else "",
                    "label": existing.get("label", "") if isinstance(existing.get("label"), str) else "",
                    "ts": int(datetime.now().timestamp() * 1000),
                    "activate": active,
                }
                atomic_write_json(target_path(), record)
                status = 200
                self.send_json(status, {"ok": True})
                return

            if path != "/annotations":
                status = 404
                self.send_json(status, {"error": "not found"})
                return
            payload, err = _read_json_body(self)
            if err is not None:
                status = 400
                self.send_json(status, {"error": err})
                return
            assert isinstance(payload, dict)
            error = validate_payload(payload)
            if error is not None:
                status = 400
                self.send_json(status, {"error": error})
                return
            path_out = store_annotation(payload)
            for adapter_name, adapter_register in ADAPTERS:
                try:
                    threading.Thread(
                        target=_dispatch_adapter,
                        args=(adapter_register, payload, path_out),
                        daemon=True,
                    ).start()
                except Exception as adapter_error:
                    LOGGER.warning("%s adapter failed to dispatch: %s", adapter_name, adapter_error)
            status = 200
            self.send_json(status, {"ok": True, "file": path_out.name})
        finally:
            print("POST %s %d" % (urlsplit(self.path).path, status), flush=True)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/status":
            self.send_json(200, status_payload())
            return
        if path == "/health":
            self.send_json(200, {"ok": True, "version": VERSION})
            return
        if path == "/target":
            target = read_target()
            if target is None:
                self.send_json(404, {"error": "no target"})
                return
            self.send_json(200, target)
            return
        if path == "/annotations":
            directory = annotations_dir()
            files: List[Dict[str, Any]] = []
            if os.path.isdir(directory):
                for name in os.listdir(directory):
                    if not name.endswith(".json") or not NAME_RE.match(name):
                        continue
                    file_path = os.path.join(directory, name)
                    try:
                        stat = os.stat(file_path)
                    except OSError:
                        continue
                    if os.path.isfile(file_path):
                        files.append({"name": name, "size": stat.st_size, "mtime": stat.st_mtime})
            files.sort(key=lambda item: item["mtime"], reverse=True)
            self.send_json(200, {"files": files})
            return
        prefix = "/annotations/"
        if path.startswith(prefix):
            name = path[len(prefix):]
            if not is_safe_name(name):
                self.send_json(404, {"error": "not found"})
                return
            file_path = os.path.join(annotations_dir(), name)
            if not os.path.isfile(file_path):
                self.send_json(404, {"error": "not found"})
                return
            try:
                with open(file_path, "rb") as annotation_file:
                    body = annotation_file.read()
            except OSError:
                self.send_json(404, {"error": "not found"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_json(404, {"error": "not found"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Comet annotation bridge")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    server = ThreadingHTTPServer((HOST, args.port), BridgeHandler)
    print("Comet annotation bridge listening on %s:%d" % (HOST, args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
