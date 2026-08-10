"""Deliver annotations to a generic webhook when configured."""

import json
import logging
import os
from typing import Any, Dict
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

LOGGER = logging.getLogger(__name__)


def register(annotation: Dict[str, Any]) -> None:
    endpoint = os.environ.get("BROWSERLINK_WEBHOOK_URL")
    if not endpoint:
        return
    body = json.dumps(annotation, ensure_ascii=False).encode("utf-8")
    request = Request(endpoint, data=body, method="POST", headers={
        "Content-Type": "application/json",
    })
    try:
        with urlopen(request, timeout=5):
            pass
    except (HTTPError, URLError, OSError, ValueError) as error:
        LOGGER.warning("Webhook adapter failed: %s", error)
