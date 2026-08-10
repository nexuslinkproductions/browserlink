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
