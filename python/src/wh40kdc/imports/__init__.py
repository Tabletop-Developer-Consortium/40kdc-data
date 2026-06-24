"""Army-list importer: decode → parse → resolve.

The adapter seam lets every supported source format plug in here without
touching ``decode`` or ``resolve``. Adapters are registered in priority
order, and every adapter's ``matches()`` predicate is tight enough that **at
most one** matches any given decoded payload — :func:`try_import_roster`
relies on that disjointness to short-circuit on the first match.

Python mirror of ``tools/src/import/import-roster.ts``. (The package is
named ``imports`` because ``import`` is a Python keyword.)
"""

from __future__ import annotations

import json
import re
from typing import Any

from wh40kdc.data.dataset import Dataset
from wh40kdc.imports.adapter import FormatAdapter, select_adapter
from wh40kdc.imports.decode import decode_listforge
from wh40kdc.imports.gw import gw_adapter
from wh40kdc.imports.listforge import listforge_adapter
from wh40kdc.imports.listforge_text import listforge_text_adapter
from wh40kdc.imports.newrecruit_json import newrecruit_json_adapter
from wh40kdc.imports.newrecruit_simple import newrecruit_simple_adapter
from wh40kdc.imports.newrecruit_wtc import (
    newrecruit_wtc_compact_adapter,
    newrecruit_wtc_full_adapter,
)
from wh40kdc.imports.resolve import resolve
from wh40kdc.imports.roster_json import roster_json_adapter
from wh40kdc.imports.rosterizer import rosterizer_adapter

Roster = dict[str, Any]

#: Adapters available to :func:`import_roster`, in match-priority order.
#:
#: NewRecruit-JSON runs ahead of ListForge because both recognise a
#: ``roster.forces`` BattleScribe payload, and the NewRecruit signature is
#: more specific. The text adapters disambiguate among themselves via
#: structural cues; wtc-full goes before wtc-compact because its matcher is
#: the more specific of the two. GW shares the WTC summary header but carries
#: ``•`` bullets and no ``N with`` lines. Rosterizer rides at the top of the
#: JSON dispatch — its ``rulebook`` + ``snapshot`` signature is structurally
#: distinct from the BattleScribe shape.
ADAPTERS: tuple[FormatAdapter, ...] = (
    # roster-json runs first: its matcher is the most specific (the canonical
    # source.format + game_version + diagnostics envelope), so a 40kdc-native
    # export is never mis-detected by a looser matcher.
    roster_json_adapter,
    rosterizer_adapter,
    newrecruit_json_adapter,
    gw_adapter,
    newrecruit_wtc_full_adapter,
    newrecruit_wtc_compact_adapter,
    newrecruit_simple_adapter,
    listforge_text_adapter,
    listforge_adapter,
)

#: The adapter list, exposed for tests that need to walk every matcher.
REGISTERED_ADAPTERS = ADAPTERS

_LISTFORGE_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def import_listforge(input: str, dataset: Dataset | None = None) -> Roster:
    """Import a ListForge share payload into a resolved 40kdc Roster.

    ``input`` may be a full ListForge URL, a bare base64 segment, or an
    already-decoded JSON string — all are handled transparently.
    """
    return import_roster(decode_listforge(input), dataset)


def import_newrecruit(input: str, dataset: Dataset | None = None) -> Roster:
    """Import a NewRecruit export (JSON, wtc-compact, wtc-full, or simple).

    The JSON form is parsed when ``input`` is valid JSON; the text forms are
    dispatched on string content. No base64/gzip decoding is attempted —
    NewRecruit exports are not encoded.
    """
    trimmed = input.lstrip()
    if trimmed.startswith("{") or trimmed.startswith("["):
        try:
            return import_roster(json.loads(input), dataset)
        except Exception:
            pass  # Fall through to treating the input as raw text.
    return import_roster(input, dataset)


def _is_canonical_roster(decoded: Any) -> bool:
    """Detect an already-resolved canonical Roster (the JSON shape produced by
    the roster-json serializer), letting canonical Roster JSON round-trip
    through :func:`import_roster` without going through an adapter."""
    if not isinstance(decoded, dict):
        return False
    source = decoded.get("source")
    return (
        isinstance(source, dict)
        and isinstance(source.get("format"), str)
        and isinstance(decoded.get("units"), list)
        and "diagnostics" in decoded
    )


def import_roster(decoded: Any, dataset: Dataset | None = None) -> Roster:
    """Import an already-decoded payload.

    Selects the matching format adapter and resolves the result against the
    dataset. Accepts either a parsed JSON object (NewRecruit JSON / ListForge
    / Rosterizer) or a string (the text formats).
    """
    if _is_canonical_roster(decoded):
        return decoded
    ds = dataset if dataset is not None else Dataset.embedded()
    adapter = select_adapter(decoded, list(ADAPTERS))
    parsed = adapter.parse(decoded)
    return resolve(parsed, ds, adapter.id)


def _looks_like_listforge_encoded(input: str) -> bool:
    """Cheap predicate: does the input look like ListForge's URL-or-base64
    wrapper?"""
    if "/listforge/" in input:
        return True
    if _LISTFORGE_URL_RE.match(input):
        return True
    # Every gzip-then-base64 payload starts with this prefix.
    if input.startswith("H4sIA"):
        return True
    return False


def try_import_roster(input: str, dataset: Dataset | None = None) -> dict[str, Any]:
    """Auto-detect and import any supported roster format from a single string.

    Pipeline:

    1. Empty input → ``empty-input``.
    2. Looks like a ListForge URL / base64 payload → decode.
    3. Looks like raw JSON (starts with ``{``/``[``) → parse.
    4. Otherwise treat as text.
    5. Greedy first-match adapter dispatch.
    6. If the matched adapter's ``parse()`` throws, that's a matcher contract
       violation — surfaced as ``parse-failed``, not silently retried.

    Never raises; the discriminated result dict carries either the resolved
    roster (with the detected format) or a typed failure plus per-adapter
    trial info for diagnostics.
    """
    trimmed = input.strip()
    if trimmed == "":
        return {"ok": False, "reason": "empty-input", "message": "input is empty", "trials": []}

    decoded: Any
    if _looks_like_listforge_encoded(trimmed):
        try:
            decoded = decode_listforge(trimmed)
        except Exception as err:
            message = str(err)
            return {
                "ok": False,
                "reason": "decode-failed",
                "message": f"failed to decode ListForge payload: {message}",
                "trials": [{"id": "listforge", "matched": False, "reason": message}],
            }
    elif trimmed.startswith("{") or trimmed.startswith("["):
        try:
            decoded = json.loads(trimmed)
        except Exception as err:
            return {
                "ok": False,
                "reason": "decode-failed",
                "message": f"input looks like JSON but failed to parse: {err}",
                "trials": [],
            }
    else:
        decoded = input

    ds = dataset if dataset is not None else Dataset.embedded()
    trials: list[dict[str, Any]] = []
    for adapter in ADAPTERS:
        if not adapter.matches(decoded):
            trials.append({"id": adapter.id, "matched": False})
            continue
        try:
            parsed = adapter.parse(decoded)
            roster = resolve(parsed, ds, adapter.id)
            return {"ok": True, "roster": roster, "format": adapter.id}
        except Exception as err:
            message = str(err)
            trials.append({"id": adapter.id, "matched": True, "reason": message})
            return {
                "ok": False,
                "reason": "parse-failed",
                "message": f"{adapter.id}: {message}",
                "trials": trials,
            }

    return {
        "ok": False,
        "reason": "no-adapter-matched",
        "message": f"tried {len(ADAPTERS)} formats, none recognised the input",
        "trials": trials,
    }


__all__ = [
    "ADAPTERS",
    "REGISTERED_ADAPTERS",
    "FormatAdapter",
    "Roster",
    "decode_listforge",
    "import_listforge",
    "import_newrecruit",
    "import_roster",
    "resolve",
    "select_adapter",
    "try_import_roster",
]
