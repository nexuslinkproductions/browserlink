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
