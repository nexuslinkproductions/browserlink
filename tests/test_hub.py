import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

import hub  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSERLINK_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HERMES_HOME", raising=False)
    hub.reload_adapters()
    return tmp_path


def payload():
    return {
        "source": "test",
        "url": "https://example.test/page",
        "title": "Test",
        "viewport": {"w": 100, "h": 100},
        "strokes": [{"color": "#f00", "width": 2, "points": [[0.1, 0.2], [0.3, 0.4]]}],
    }


def test_validation_and_atomic_round_trip(data_dir):
    assert hub.validate_payload(payload()) is None
    assert hub.validate_payload({"source": "x"}) == "url must be a string"
    assert hub.validate_payload(dict(payload(), label="x" * 201)) == "label must be at most 200 characters"

    path = hub.store_annotation(payload())
    assert path.parent == data_dir / "annotations"
    assert path.name.endswith(".json")
    assert json.loads(path.read_text()) == payload()
    assert not list(path.parent.glob(".annotation-*.tmp"))


def test_traversal_names_rejected(data_dir):
    assert not hub.is_safe_name("../escape.json")
    assert not hub.is_safe_name("dir\\escape.json")
    assert not hub.is_safe_name("..");
    assert hub.is_safe_name("20260101-000000-000.json")


def test_data_dir_precedence(monkeypatch, tmp_path):
    explicit = tmp_path / "explicit"
    hermes = tmp_path / "hermes"
    monkeypatch.setenv("BROWSERLINK_DATA_DIR", str(explicit))
    monkeypatch.setenv("HERMES_HOME", str(hermes))
    assert hub.data_dir() == explicit
    monkeypatch.delenv("BROWSERLINK_DATA_DIR")
    assert hub.data_dir() == hermes / "annotations"


def test_status_has_adapter_names(data_dir):
    status = hub.status_payload()
    assert status["ok"] is True
    assert status["version"] == "1.0.0"
    assert status["dataDir"] == str(data_dir)
    assert isinstance(status["adapters"], list)


ALL_EDIT_KEYS = [
    "width", "height", "fontFamily", "fontSize", "fontWeight", "lineHeight",
    "color", "backgroundColor", "text", "href", "display", "margin",
    "padding", "borderRadius",
]


def test_elements_edits_round_trip(data_dir):
    p = payload()
    p["elements"] = [{
        "index": 1,
        "tag": "button",
        "text": "Log in",
        "instruction": "Make this blue and round",
        "edits": {"width": "48px", "fontSize": "16px", "color": "#0af", "text": "Shop now"},
    }]
    assert hub.validate_payload(p) is None
    path = hub.store_annotation(p)
    stored = json.loads(path.read_text())
    assert stored["elements"][0]["edits"] == p["elements"][0]["edits"]


def test_elements_edits_all_allowed_keys_round_trip(data_dir):
    p = payload()
    p["elements"] = [{"index": 1, "tag": "div", "edits": {k: "v" for k in ALL_EDIT_KEYS}}]
    assert hub.validate_payload(p) is None
    path = hub.store_annotation(p)
    assert json.loads(path.read_text())["elements"][0]["edits"] == p["elements"][0]["edits"]


def test_elements_edits_unknown_key_rejected():
    p = payload()
    p["elements"] = [{"index": 1, "tag": "button", "edits": {"bogusKey": "1px"}}]
    assert hub.validate_payload(p) == "elements[0].edits has unknown key 'bogusKey'"


def test_elements_edits_values_must_be_strings():
    p = payload()
    p["elements"] = [{"index": 1, "tag": "button", "edits": {"width": 48}}]
    assert hub.validate_payload(p) == "elements[0].edits.width must be a string"


def test_elements_edits_must_be_an_object():
    p = payload()
    p["elements"] = [{"index": 1, "tag": "button", "edits": "48px"}]
    assert hub.validate_payload(p) == "elements[0].edits must be an object"


# --- /target + /activate (v1.3) ---


@pytest.fixture
def hub_server(data_dir):
    import threading
    from http.server import ThreadingHTTPServer
    from urllib.request import Request, urlopen

    server = ThreadingHTTPServer(("127.0.0.1", 0), hub.BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    base = "http://127.0.0.1:%d" % port

    def request(method, path, body=None):
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = Request(base + path, data=data, method=method, headers=headers)
        try:
            with urlopen(req, timeout=2) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except Exception as err:
            from urllib.error import HTTPError
            if isinstance(err, HTTPError):
                return err.code, json.loads(err.read().decode("utf-8"))
            raise

    yield request
    server.shutdown()
    server.server_close()


def test_target_post_get_round_trip(hub_server):
    status, body = hub_server("POST", "/target", {
        "sessionId": "sess-abc",
        "label": "demo chat",
        "activate": True,
    })
    assert status == 200
    assert body == {"ok": True}

    status, body = hub_server("GET", "/target")
    assert status == 200
    assert body["sessionId"] == "sess-abc"
    assert body["label"] == "demo chat"
    assert body["activate"] is True
    assert isinstance(body["ts"], int)


def test_activate_merge_preserves_session_id(hub_server):
    hub_server("POST", "/target", {
        "sessionId": "keep-me",
        "label": "keep-label",
        "activate": True,
    })
    status, body = hub_server("POST", "/activate", {"active": False})
    assert status == 200
    assert body == {"ok": True}

    status, body = hub_server("GET", "/target")
    assert status == 200
    assert body["sessionId"] == "keep-me"
    assert body["label"] == "keep-label"
    assert body["activate"] is False


def test_empty_session_id_rejected(hub_server):
    status, body = hub_server("POST", "/target", {"sessionId": "", "label": "x"})
    assert status == 400
    assert "sessionId" in body["error"]


def test_status_includes_target(hub_server):
    status, body = hub_server("GET", "/status")
    assert status == 200
    assert body["target"] is None

    hub_server("POST", "/target", {"sessionId": "s1", "label": "L"})
    status, body = hub_server("GET", "/status")
    assert status == 200
    assert body["target"] == {"sessionId": "s1", "label": "L"}


# --- screenshot attachment (v1.4) ---

# 1x1 transparent PNG
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
TINY_PNG_DATA_URL = "data:image/png;base64," + TINY_PNG_B64


def test_screenshot_stores_png_and_screenshot_file(data_dir):
    p = payload()
    p["screenshot"] = TINY_PNG_DATA_URL
    assert hub.validate_payload(p) is None
    path = hub.store_annotation(p)
    stored = json.loads(path.read_text())
    assert "screenshot" not in stored
    assert "screenshotFile" in stored
    png_name = stored["screenshotFile"]
    assert png_name.endswith(".png")
    png_path = path.parent / png_name
    assert png_path.is_file()
    assert png_path.stat().st_size > 0
    # PNG magic bytes
    assert png_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_screenshot_non_png_data_url_rejected():
    p = payload()
    p["screenshot"] = "data:image/jpeg;base64,/9j/4AAQ"
    err = hub.validate_payload(p)
    assert err is not None
    assert "screenshot" in err


def test_payload_without_screenshot_unchanged(data_dir):
    p = payload()
    assert "screenshot" not in p
    assert hub.validate_payload(p) is None
    path = hub.store_annotation(p)
    stored = json.loads(path.read_text())
    assert stored == p
    assert "screenshotFile" not in stored
    assert list(path.parent.glob("*.png")) == []


def test_screenshot_via_http(hub_server, data_dir):
    p = payload()
    p["screenshot"] = TINY_PNG_DATA_URL
    status, body = hub_server("POST", "/annotations", p)
    assert status == 200
    assert body["ok"] is True
    name = body["file"]
    stored = json.loads((data_dir / "annotations" / name).read_text())
    assert "screenshotFile" in stored
    assert (data_dir / "annotations" / stored["screenshotFile"]).is_file()
