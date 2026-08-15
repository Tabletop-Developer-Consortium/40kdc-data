"""ListForge plain-text adapter: lower ListForge's copy-paste text export to a
``ParsedRoster``.

This is the bullet-list text users copy out of the ListForge app (distinct
from the base64+gzip share-JSON the ``listforge`` adapter handles). Shape::

    all gas no breaks - Chaos Daemons - Daemonic Incursion (1995 Points)

    Epic Hero:
    Rotigus (250 pts)
      • Gnarlrod
      • Streams of brackish filth

    Battleline:
    Bloodletters (110 pts)
      • Bloodreaper
        • Hellblade
      • Daemonic Icon
      • 9x Bloodletter
        • 9x Hellblade

- The first non-blank line is ``<list name> - <faction> -
  [<disposition> - ]<detachment(s)> (<N> Points)``. The name is a single
  segment (a name containing `` - `` breaks the split — a documented ListForge
  limitation, not ours), the faction the second, the LAST segment the
  detachment list (comma-joined when a list fields several under an 11e
  detachment-point cap), and any segment in between the selected Force
  Disposition. Legacy 3-segment headers with no disposition still parse.
- Sections are mixed-case battlefield-role lines ending with ``:``
  (``Epic Hero:``, ``Character:``, ``Battleline:``, …). Units under
  ``Epic Hero:`` or ``Character:`` are characters.
- An ``Attached Units:`` section groups leader+bodyguard pairs. Each group is a
  combined ``<Leader> + <Bodyguard> (<total> pts)`` header (a marker, not a
  unit — its points are the sub-units' sum) followed by the leader and
  bodyguard as indented sub-units, leader first. The leader is emitted as a
  character carrying an explicit ``leader``-role ``leader_attachment`` to the
  bodyguard, so ``resolve`` reconstructs the link directly.
- Bullet classification mirrors the GW adapter: a top-level bullet with deeper
  children is a **model group** (its ``Nx`` count — implicitly 1 — adds to the
  model count); without children it's **wargear**. Child-bullet ``Nx`` counts
  are already squad-wide totals; a child without a count is one item
  (``• Hellblade`` under a lone Bloodreaper).
- ``E: <name>`` is the enhancement annotation (ListForge reports no points for
  it, so ``enhancement_points`` stays None and unit points stay as displayed).
  A bare ``Warlord`` bullet flags the warlord.

**Disjointness**: the ``(N Points)`` first-line suffix is unique to this
format — newrecruit-simple's first line ends ``- [N pts]``, the GW export opens
with a ``++++`` fence, and the WTC formats carry ``N with`` lines or no bullets
at all.

Python mirror of ``tools/src/import/listforge-text.ts``.
"""

from __future__ import annotations

import re
from typing import Any

from wh40kdc.imports.adapter import FormatAdapter
from wh40kdc.imports.newrecruit_text import infer_battle_size_raw

_FIRST_LINE = re.compile(r"^(.+)\s\(\s*(\d+)\s*Points?\s*\)\s*$", re.IGNORECASE)
_SECTION_HEADER = re.compile(r"^[A-Za-z][A-Za-z0-9 /&'-]*:$")
_UNIT_HEADER = re.compile(r"^(.+?)\s*\(\s*(\d+)\s*pts?\s*\)\s*$", re.IGNORECASE)
_BULLET_LINE = re.compile(r"^(\s*)•\s*(.+?)\s*$")
_NX_PREFIX = re.compile(r"^(\d+)x\s+(.+)$")
_BULLET = re.compile(r"^[\t ]*•", re.MULTILINE)
_WITH_LINE = re.compile(r"^[\t ]*\d+\s+with\b", re.MULTILINE)
_SPLIT_LINES = re.compile(r"\r?\n")

_ENHANCEMENT_PREFIX = "E: "
_WARLORD_MARKER = "Warlord"
_CHARACTER_SECTIONS = frozenset({"epic hero", "character"})
# ListForge groups leader+bodyguard pairs under this section: a combined
# `Leader + Bodyguard (total pts)` marker followed by the two units as indented
# sub-entries (leader first), so the leader's attachment is explicit.
_ATTACHED_SECTION = "attached units"
_ATTACHED_SEP = " + "


def _is_listforge_text(decoded: Any) -> str | None:
    """Accept plain text whose first non-blank line is the ListForge
    ``name - faction - detachment (N Points)`` header, with ``•`` bullets and
    no WTC ``N with`` lines."""
    if not isinstance(decoded, str):
        return None
    first_non_blank = next((line for line in _SPLIT_LINES.split(decoded) if line.strip()), None)
    if not first_non_blank:
        return None
    first = _FIRST_LINE.match(first_non_blank.strip())
    if not first or len(first.group(1).split(" - ")) < 3:
        return None
    if _BULLET.search(decoded) is None:
        return None
    if _WITH_LINE.search(decoded) is not None:
        return None
    return decoded


def _split_detachments(segment: str) -> list[str]:
    """Split a detachment segment on commas — 11e lists field several
    detachments comma-joined in a single header segment (``"A, B"``); one
    detachment stays one."""
    return [s for s in (p.strip() for p in segment.split(",")) if s]


def _parse_first_line(line: str) -> dict[str, Any] | None:
    m = _FIRST_LINE.match(line.strip())
    if not m:
        return None
    parts = [s for s in (p.strip() for p in m.group(1).split(" - ")) if s]
    if len(parts) < 3:
        return None
    # `<name> - <faction> - [<disposition> - ]<detachment(s)>`. The name is the
    # first segment (ListForge never inserts ` - `), the faction the second, the
    # LAST segment the comma-joined detachment list, and any segment in between
    # is the selected Force Disposition. Legacy 3-segment headers have no
    # disposition.
    return {
        "name": parts[0],
        "faction_raw_name": parts[1],
        "detachment_raw_names": _split_detachments(parts[-1]),
        "disposition_raw_name": parts[-2] if len(parts) >= 4 else None,
        "total_reported": int(m.group(2)),
    }


def _finish_unit(acc: dict[str, Any]) -> dict[str, Any]:
    bullets: list[dict[str, Any]] = acc["bullets"]
    top_indent = min((b["indent"] for b in bullets), default=0)

    # Insertion-ordered aggregation (dict preserves order, matching the TS Map).
    wargear: dict[str, int] = {}
    model_count = 0
    is_warlord = False
    enhancement_raw_name: str | None = None

    def add_wargear(raw_name: str, count: int) -> None:
        wargear[raw_name] = wargear.get(raw_name, 0) + count

    for i, b in enumerate(bullets):
        # Child bullet: a model group's weapon. ListForge child counts are
        # squad-wide totals; a count-less child is a single item.
        if b["indent"] > top_indent:
            add_wargear(b["text"], b["count"] if b["count"] is not None else 1)
            continue

        # Top-level annotations.
        if b["count"] is None:
            if b["text"] == _WARLORD_MARKER:
                is_warlord = True
                continue
            if b["text"].startswith(_ENHANCEMENT_PREFIX):
                if enhancement_raw_name is None:
                    enhancement_raw_name = b["text"][len(_ENHANCEMENT_PREFIX) :].strip()
                continue

        # Top-level entry: a model group when it has child bullets beneath it,
        # otherwise plain wargear. Either way a missing `Nx` count means 1.
        next_bullet = bullets[i + 1] if i + 1 < len(bullets) else None
        if next_bullet is not None and next_bullet["indent"] > b["indent"]:
            model_count += b["count"] if b["count"] is not None else 1
        else:
            add_wargear(b["text"], b["count"] if b["count"] is not None else 1)

    if model_count == 0:
        model_count = 1

    return {
        "raw_name": acc["raw_name"],
        "is_character": acc["is_character"],
        "model_count": model_count,
        "points": acc["displayed_pts"],
        "is_warlord": is_warlord,
        "enhancement_raw_name": enhancement_raw_name,
        # ListForge's text export reports no enhancement cost, so the unit's
        # displayed points stay as-is and no enhancement points are claimed.
        "enhancement_points": None,
        "wargear": [{"raw_name": n, "count": c} for n, c in wargear.items()],
        # Always present (None for an ordinary unit) so the serialized key
        # mirrors the TS adapter, which sets `leader_attachment` on every unit.
        "leader_attachment": acc.get("leader_attachment"),
    }


def _matches(decoded: Any) -> bool:
    return _is_listforge_text(decoded) is not None


def _parse(decoded: Any) -> dict[str, Any]:
    text = _is_listforge_text(decoded)
    if text is None:
        raise ValueError("listforge-text: input is not a ListForge text export")

    lines = _SPLIT_LINES.split(text)
    header: dict[str, Any] | None = None
    units: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    section_is_character = False
    # `Attached Units:` section state. A combined `Leader + Bodyguard` header
    # sets `pending_bodyguard_name`; the next two sub-units are the leader
    # (`group_member_index` 0, a character) and the bodyguard (index 1).
    in_attached_section = False
    pending_bodyguard_name: str | None = None
    group_member_index = 0

    def finalize() -> None:
        nonlocal current
        if current is not None:
            units.append(_finish_unit(current))
            current = None

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        if header is None:
            header = _parse_first_line(line)
            if header is not None:
                continue

        bullet_match = _BULLET_LINE.match(raw)
        if bullet_match:
            if current is not None:
                rest = bullet_match.group(2)
                nx = _NX_PREFIX.match(rest)
                current["bullets"].append(
                    {
                        "indent": len(bullet_match.group(1)),
                        "count": int(nx.group(1)) if nx else None,
                        "text": (nx.group(2) if nx else rest).strip(),
                    }
                )
            continue

        if _SECTION_HEADER.match(line):
            finalize()
            heading = line[:-1].strip().lower()
            section_is_character = heading in _CHARACTER_SECTIONS
            in_attached_section = heading == _ATTACHED_SECTION
            pending_bodyguard_name = None
            group_member_index = 0
            continue

        unit_match = _UNIT_HEADER.match(line)
        if unit_match:
            raw_name = unit_match.group(1).strip()

            # In the attached section, a `Leader + Bodyguard (total pts)` header
            # is a grouping marker, not a unit: skip it (its points are the
            # sub-units' sum, so emitting it would double-count) and remember
            # the bodyguard name.
            if in_attached_section and _ATTACHED_SEP in raw_name:
                finalize()
                pending_bodyguard_name = raw_name.split(_ATTACHED_SEP, 1)[1].strip()
                group_member_index = 0
                continue

            finalize()
            # First sub-unit of a group (index 0) is the attaching leader — a
            # character carrying an explicit `leader`-role attachment to the
            # bodyguard; the second (index 1) is the bodyguard itself.
            is_attached_leader = (
                in_attached_section
                and pending_bodyguard_name is not None
                and group_member_index == 0
            )
            current = {
                "raw_name": raw_name,
                "displayed_pts": int(unit_match.group(2)),
                "is_character": (
                    is_attached_leader if in_attached_section else section_is_character
                ),
                "bullets": [],
                "leader_attachment": (
                    {
                        "bodyguard_raw_name": pending_bodyguard_name,
                        "role": "leader",
                        "provisional": False,
                    }
                    if is_attached_leader
                    else None
                ),
            }
            if in_attached_section:
                group_member_index += 1

    finalize()

    if header is None:
        raise ValueError("listforge-text: missing ListForge header line")

    total_computed = 0
    for u in units:
        total_computed += u["points"] or 0

    # Like the GW export, ListForge text reports only the army total — use it as
    # the declared limit so battle-size inference stays round-trippable.
    declared_limit = header["total_reported"]

    return {
        "name": header["name"],
        "generated_by": "List Forge",
        "faction_raw_name": header["faction_raw_name"],
        "detachment_raw_names": header["detachment_raw_names"],
        # ListForge text always carries the header disposition slot (None for a
        # legacy 3-segment header), so the key is always present — matching the
        # TS adapter's explicit `force_disposition_raw_name`.
        "force_disposition_raw_name": header["disposition_raw_name"],
        "battle_size_raw": infer_battle_size_raw(declared_limit),
        "declared_limit": declared_limit,
        "total_reported": header["total_reported"],
        "total_computed": total_computed,
        "units": units,
        "multi_force": False,
    }


listforge_text_adapter = FormatAdapter(id="listforge-text", matches=_matches, parse=_parse)
