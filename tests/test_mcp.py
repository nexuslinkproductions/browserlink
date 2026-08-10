import json
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp"))

import mcp_server  # noqa: E402


@pytest.fixture
def annotations(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSERLINK_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HERMES_HOME", raising=False)
    directory = tmp_path / "annotations"
    directory.mkdir()
    first = directory / "20260101-000000-000.json"
    second = directory / "20260101-000001-000.json"
    first.write_text(json.dumps({"url": "https://one.test", "label": "one"}))
    second.write_text(json.dumps({"url": "https://two.test", "label": "two"}))
    return tmp_path, first.name, second.name


def test_hub_status_and_list(annotations):
    data_dir, first, second = annotations
    status = mcp_server.hub_status()
    assert status["ok"] is True
    assert status["dataDir"] == str(data_dir)
    listed = mcp_server.annotations_list(limit=20)
    assert [item["name"] for item in listed] == [second, first]


def test_latest_get_and_limit(annotations):
    _, first, second = annotations
    assert mcp_server.annotations_latest()["label"] == "two"
    assert mcp_server.annotations_get(first)["label"] == "one"
    assert mcp_server.annotations_list(limit=1)[0]["name"] == second
    with pytest.raises(ValueError):
        mcp_server.annotations_get("../escape.json")


def test_watch_returns_new_files(annotations):
    data_dir, _, _ = annotations
    new_file = data_dir / "annotations" / "20260101-000002-000.json"

    def create_file():
        time.sleep(0.01)
        new_file.write_text(json.dumps({"url": "https://new.test"}))

    creator = threading.Thread(target=create_file)
    creator.start()
    watched = mcp_server.annotations_watch(seconds=0.05)
    creator.join()
    assert watched == [new_file.name]


@pytest.fixture
def live_hub(tmp_path, monkeypatch):
    """Start a real hub on an ephemeral port for MCP connect tools."""
    monkeypatch.setenv("BROWSERLINK_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HERMES_HOME", raising=False)

    server_root = ROOT / "server"
    if str(server_root) not in sys.path:
        sys.path.insert(0, str(server_root))
    import hub  # noqa: E402

    hub.reload_adapters()
    from http.server import ThreadingHTTPServer

    server = ThreadingHTTPServer(("127.0.0.1", 0), hub.BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    monkeypatch.setenv("BROWSERLINK_HUB_URL", "http://127.0.0.1:%d" % port)
    yield tmp_path
    server.shutdown()
    server.server_close()


def test_browserlink_connect_disconnect_status(live_hub):
    connected = mcp_server.browserlink_connect(
        sessionId="mcp-sess-1",
        label="mcp label",
        activate=True,
    )
    assert connected["ok"] is True
    assert connected["sessionId"] == "mcp-sess-1"
    assert connected["label"] == "mcp label"
    assert connected["activate"] is True

    status = mcp_server.browserlink_status()
    assert status["ok"] is True
    assert status["target"]["sessionId"] == "mcp-sess-1"
    assert status["target"]["label"] == "mcp label"
    assert status["target"]["activate"] is True

    disconnected = mcp_server.browserlink_disconnect()
    assert disconnected == {"ok": True}

    status = mcp_server.browserlink_status()
    assert status["ok"] is True
    assert status["target"] is None
