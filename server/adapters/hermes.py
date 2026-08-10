"""Deliver annotations to a Hermes session when configured."""

import json
import logging
import os
from typing import Any, Dict, List
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

LOGGER = logging.getLogger(__name__)


def _message(annotation: Dict[str, Any]) -> str:
    url = annotation.get("url", "")
    label = annotation.get("label", "")
    parts: List[str] = []
    for number, element in enumerate(annotation.get("elements", []), 1):
        tag = element.get("tag", "")
        element_id = element.get("id")
        text = element.get("text", "")
        tag_name = tag + ("#" + element_id if element_id else "")
        part = "E%d: %s '%s'" % (number, tag_name, text)
        instruction = element.get("instruction")
        if instruction:
            part += " — instruction: " + instruction
        parts.append(part)
    return " — ".join([url, label] + parts)


def register(annotation: Dict[str, Any]) -> None:
    api_url = os.environ.get("HERMES_API_URL")
    api_key = os.environ.get("HERMES_API_KEY")
    session_id = os.environ.get("HERMES_SESSION_ID")
    if not (api_url and api_key and session_id):
        return
    endpoint = api_url.rstrip("/") + "/api/sessions/%s/chat" % session_id
    body = json.dumps({"message": _message(annotation)}).encode("utf-8")
    request = Request(endpoint, data=body, method="POST", headers={
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
    })
    try:
        with urlopen(request, timeout=5):
            pass
    except (HTTPError, URLError, OSError, ValueError) as error:
        LOGGER.warning("Hermes adapter failed: %s", error)
