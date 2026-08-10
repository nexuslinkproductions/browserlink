"""Deliver annotations to a Hermes session when configured."""

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

LOGGER = logging.getLogger(__name__)


def _data_dir() -> Path:
    configured = os.environ.get("BROWSERLINK_DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return Path(hermes_home).expanduser() / "annotations"
    return Path.home() / ".browserlink" / "annotations"


def _read_target_session_id() -> Optional[str]:
    """Fresh read of target.json sessionId (target-over-env resolution)."""
    path = _data_dir() / "target.json"
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    session_id = value.get("sessionId")
    if isinstance(session_id, str) and session_id.strip():
        return session_id.strip()
    return None


def _resolve_session_id() -> Optional[str]:
    # target.json sessionId wins over HERMES_SESSION_ID env (target-over-env).
    target_sid = _read_target_session_id()
    if target_sid:
        return target_sid
    env_sid = os.environ.get("HERMES_SESSION_ID")
    if isinstance(env_sid, str) and env_sid.strip():
        return env_sid.strip()
    return None


def _session_model_config(session_id: str) -> Dict[str, Any]:
    """Read the session's own model_config from the Hermes state DB.

    Delivery must follow whatever provider/model the session actually runs
    on (any provider, any model) instead of a hardcoded pin. The session row
    stores its runtime as JSON in ``model_config`` (model, provider,
    base_url, api_mode); the API server's session-chat endpoint honors
    explicit provider/model in the request body, so we resolve them here.
    """
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        db_path = Path(hermes_home).expanduser() / "state.db"
    else:
        db_path = Path.home() / ".hermes" / "state.db"
    if not db_path.is_file():
        return {}
    try:
        import sqlite3

        conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True, timeout=5)
        try:
            row = conn.execute(
                "SELECT model_config FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
        finally:
            conn.close()
        if not row or not row[0]:
            return {}
        value = json.loads(row[0])
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _element_tag_name(element: Dict[str, Any]) -> str:
    tag = element.get("tag", "") or ""
    element_id = element.get("id")
    class_name = element.get("className") or element.get("class") or ""
    parts = [str(tag)]
    if element_id:
        parts[0] = parts[0] + "#" + str(element_id)
    if class_name:
        classes = str(class_name).split()
        for cls in classes:
            if cls:
                parts[0] = parts[0] + "." + cls
    return parts[0]


def _format_edits(edits: Any) -> str:
    if not isinstance(edits, dict) or not edits:
        return ""
    bits = []
    for key, value in edits.items():
        bits.append("%s=%s" % (key, value))
    return " ".join(bits)


def _message(annotation: Dict[str, Any], annotation_path: Optional[str] = None, include_image_ref: bool = True) -> str:
    lines: List[str] = []

    # Schema v1.4: @image first when the sibling PNG exists on disk. Skipped
    # when the caller sends the screenshot as a real image_url part (the text
    # ref would duplicate the image).
    if include_image_ref:
        screenshot_file = annotation.get("screenshotFile")
        if isinstance(screenshot_file, str) and screenshot_file:
            if annotation_path:
                png_path = Path(annotation_path).resolve().parent / screenshot_file
            else:
                png_path = _data_dir() / "annotations" / screenshot_file
            if png_path.is_file():
                lines.append("@image:%s" % str(png_path.resolve()))

    lines.append("📎 browserlink annotation")
    lines.append("URL: %s" % (annotation.get("url", "") or ""))
    lines.append("Title: %s" % (annotation.get("title", "") or ""))
    lines.append("Label: %s" % (annotation.get("label", "") or ""))

    elements = annotation.get("elements") or []
    if isinstance(elements, list):
        for number, element in enumerate(elements, 1):
            if not isinstance(element, dict):
                continue
            tag_name = _element_tag_name(element)
            text = element.get("text", "") or ""
            part = "E%d: %s '%s'" % (number, tag_name, text)
            instruction = element.get("instruction")
            if instruction:
                part += " - instruction: " + str(instruction)
            edits = element.get("edits")
            edits_str = _format_edits(edits)
            if edits_str:
                part += " - edits: " + edits_str
            lines.append(part)

    strokes = annotation.get("strokes") or []
    stroke_count = len(strokes) if isinstance(strokes, list) else 0
    lines.append("%d stroke(s)" % stroke_count)

    # Always append @file last when the annotation JSON exists.
    if annotation_path:
        json_path = Path(annotation_path)
        if json_path.is_file():
            lines.append("@file:%s" % str(json_path.resolve()))

    return "\n".join(lines)


def _screenshot_png_path(annotation: Dict[str, Any], annotation_path: Optional[str]) -> Optional[Path]:
    screenshot_file = annotation.get("screenshotFile")
    if not (isinstance(screenshot_file, str) and screenshot_file):
        return None
    if annotation_path:
        png_path = Path(annotation_path).resolve().parent / screenshot_file
    else:
        png_path = _data_dir() / "annotations" / screenshot_file
    return png_path if png_path.is_file() else None


# Base64 inflates 4/3; the API server caps request bodies at 10 MB. Keep a
# margin so the image part never trips the cap.
MAX_IMAGE_PART_BYTES = 7_000_000


def _image_data_url(png_path: Path) -> Optional[str]:
    try:
        if png_path.stat().st_size > MAX_IMAGE_PART_BYTES:
            return None
        import base64

        with png_path.open("rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("ascii")
        return "data:image/png;base64," + encoded
    except OSError:
        return None


def register(annotation: Dict[str, Any], annotation_path: Optional[str] = None) -> None:
    api_url = os.environ.get("HERMES_API_URL")
    api_key = os.environ.get("HERMES_API_KEY")
    if not (api_url and api_key):
        return
    session_id = _resolve_session_id()
    if not session_id:
        LOGGER.info(
            "Hermes adapter: no sessionId in target.json or HERMES_SESSION_ID; skipping delivery"
        )
        return
    endpoint = api_url.rstrip("/") + "/api/sessions/%s/chat" % session_id
    body_dict: Dict[str, Any] = {"message": _message(annotation, annotation_path)}
    # Route the turn to the backend the session actually runs on. The API
    # server's session-chat route resolution only consults model_routes
    # (usually empty) before falling to the global default provider, which
    # may reject the session's model. Resolve the session's own runtime from
    # its model_config (any provider/model), with explicit env overrides
    # taking precedence for special cases.
    provider = os.environ.get("HERMES_PROVIDER")
    model = os.environ.get("HERMES_MODEL")
    if not (provider and model):
        session_cfg = _session_model_config(session_id)
        if not provider:
            provider = session_cfg.get("provider")
        if not model:
            model = session_cfg.get("model")
    if provider:
        body_dict["provider"] = provider
    if model:
        body_dict["model"] = model
    # Land the screenshot as a REAL image attachment: the API server's
    # session-chat endpoint accepts OpenAI-style content parts, and the desktop
    # renders image_url parts inline. A bare "@image:" text ref would be stored
    # as literal text (the desktop's @image rendering only applies to its own
    # input path). The JSON file cannot be an attachment on this endpoint
    # (file parts are rejected), so it stays as an @file: text ref.
    png_path = _screenshot_png_path(annotation, annotation_path)
    data_url = _image_data_url(png_path) if png_path else None
    if data_url:
        # Send BOTH the image part and the @image: ref: the part feeds the
        # agent's vision, the ref is what the desktop lifts into a rendered
        # attachment thumbnail (it drops the [screenshot] placeholder when a
        # ref is present). Without the ref the desktop shows literal text.
        body_dict["message"] = [
            {"type": "image_url", "image_url": {"url": data_url}},
            {"type": "text", "text": _message(annotation, annotation_path)},
        ]
    body = json.dumps(body_dict).encode("utf-8")
    request = Request(endpoint, data=body, method="POST", headers={
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
    })
    try:
        with urlopen(request, timeout=300):
            pass
    except (HTTPError, URLError, OSError, ValueError) as error:
        LOGGER.warning("Hermes adapter failed: %s", error)
