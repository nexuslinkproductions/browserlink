import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from adapters import hermes  # noqa: E402


# Minimal valid 1x1 PNG bytes
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSERLINK_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("HERMES_HOME", raising=False)
    return tmp_path


def annotation():
    return {
        "source": "test",
        "url": "https://example.test/page",
        "title": "Test",
        "label": "lbl",
        "viewport": {"w": 100, "h": 100},
        "strokes": [{"color": "#f00", "width": 2, "points": [[0.1, 0.2], [0.3, 0.4]]}],
        "elements": [],
    }


def test_message_includes_image_and_file_when_present(data_dir):
    ann_dir = data_dir / "annotations"
    ann_dir.mkdir(parents=True)
    png_path = ann_dir / "20260101-000000-000.png"
    json_path = ann_dir / "20260101-000000-000.json"
    png_path.write_bytes(TINY_PNG)
    ann = annotation()
    ann["screenshotFile"] = png_path.name
    json_path.write_text(json.dumps(ann), encoding="utf-8")

    msg = hermes._message(ann, str(json_path))
    lines = msg.split("\n")
    assert lines[0] == "@image:%s" % str(png_path.resolve())
    assert lines[-1] == "@file:%s" % str(json_path.resolve())
    assert "📎 browserlink annotation" in msg
    assert "URL: https://example.test/page" in msg


def test_message_omits_image_and_file_when_missing(data_dir):
    ann = annotation()
    ann["screenshotFile"] = "missing.png"
    msg = hermes._message(ann, str(data_dir / "annotations" / "missing.json"))
    assert "@image:" not in msg
    assert "@file:" not in msg
    assert msg.startswith("📎 browserlink annotation")


def test_message_omits_image_when_png_missing_but_keeps_file(data_dir):
    ann_dir = data_dir / "annotations"
    ann_dir.mkdir(parents=True)
    json_path = ann_dir / "only.json"
    ann = annotation()
    ann["screenshotFile"] = "gone.png"
    json_path.write_text(json.dumps(ann), encoding="utf-8")

    msg = hermes._message(ann, str(json_path))
    assert "@image:" not in msg
    assert msg.split("\n")[-1] == "@file:%s" % str(json_path.resolve())
