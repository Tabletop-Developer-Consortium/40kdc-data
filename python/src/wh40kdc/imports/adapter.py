"""The format-adapter seam.

Each supported source format implements :class:`FormatAdapter`: it recognises
a decoded payload (``matches``) and lowers it to the format-agnostic
``ParsedRoster`` dict (``parse``). Resolution onto 40kdc entity ids happens
once, downstream, against any ``ParsedRoster`` — so adding a new source
format means writing one adapter, not touching the resolver.

Python mirror of ``tools/src/import/adapter.ts``.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class FormatAdapter:
    """Recognises and parses one source list-export format."""

    #: Stable identifier for the format. Carries through to ``roster.source.format``.
    id: str
    #: True when this adapter can parse the given decoded payload.
    matches: Callable[[Any], bool]
    #: Lower a recognised payload to the format-agnostic intermediate.
    parse: Callable[[Any], dict[str, Any]]


def select_adapter(decoded: Any, adapters: list[FormatAdapter]) -> FormatAdapter:
    """Pick the first adapter that recognises the payload."""
    for adapter in adapters:
        if adapter.matches(decoded):
            return adapter
    tried = ", ".join(a.id for a in adapters) or "none"
    raise ValueError(f"no registered import adapter recognises this payload (tried: {tried})")
