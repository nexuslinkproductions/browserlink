"""Interface for Browserlink annotation delivery adapters."""

from typing import Dict


def register(annotation: Dict) -> None:
    """Deliver an annotation, or do nothing for this adapter."""
    raise NotImplementedError
