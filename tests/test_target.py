"""Adapter target.json session resolution (v1.3)."""

import json
import sys
from pathlib import Path
from urllib.request import Request

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from adapters import hermes  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSERLINK_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HERMES_HOME", raising=False)
    return tmp_path


def annotation():
    return {
        "url": "https://example.test/login",
        "title": "Login",
        "label": "qa",
        "elements": [
            {
                "tag": "button",
                "id": "submit",
                "className": "btn",
                "text": "Log in",
                "instruction": "Make primary",
                "edits": {"width": "48px", "fontSize": "16px"},
            }
        ],
        "strokes": [{"color": "#f00", "width": 2, "points": [[0.1, 0.2], [0.3, 0.4]]}],
    }


def test_target_session_wins_over_env(data_dir, monkeypatch):
    """target.json sessionId wins over HERMES_SESSION_ID (target-over-env)."""
    monkeypatch.setenv("HERMES_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("HERMES_API_KEY", "test-key")
    monkeypatch.setenv("HERMES_SESSION_ID", "env-session")

    target = {
        "sessionId": "target-session",
        "label": "from-target",
        "ts": 1,
        "activate": False,
    }
    (data_dir / "target.json").write_text(json.dumps(target), encoding="utf-8")

    captured = {}

    def fake_urlopen(request, timeout=5):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data.decode("utf-8"))

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        return Resp()

    monkeypatch.setattr(hermes, "urlopen", fake_urlopen)
    hermes.register(annotation())

    assert "target-session" in captured["url"]
    assert "env-session" not in captured["url"]
    message = captured["body"]["message"]
    assert message.startswith("📎 browserlink annotation\n")
    assert "URL: https://example.test/login" in message
    assert "Title: Login" in message
    assert "Label: qa" in message
    assert "E1: button#submit.btn 'Log in' - instruction: Make primary - edits: width=48px fontSize=16px" in message
    assert "1 stroke(s)" in message


def test_falls_back_to_env_when_no_target(data_dir, monkeypatch):
    monkeypatch.setenv("HERMES_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("HERMES_API_KEY", "test-key")
    monkeypatch.setenv("HERMES_SESSION_ID", "env-only")

    captured = {}

    def fake_urlopen(request, timeout=5):
        captured["url"] = request.full_url

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        return Resp()

    monkeypatch.setattr(hermes, "urlopen", fake_urlopen)
    hermes.register(annotation())
    assert "env-only" in captured["url"]


def test_no_session_is_noop(data_dir, monkeypatch, caplog):
    monkeypatch.setenv("HERMES_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("HERMES_API_KEY", "test-key")
    monkeypatch.delenv("HERMES_SESSION_ID", raising=False)

    called = []

    def fake_urlopen(request, timeout=5):
        called.append(request)
        raise AssertionError("should not call hub")

    monkeypatch.setattr(hermes, "urlopen", fake_urlopen)
    with caplog.at_level("INFO"):
        hermes.register(annotation())
    assert called == []
    assert any("no sessionId" in record.getMessage() for record in caplog.records)
