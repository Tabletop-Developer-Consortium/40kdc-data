"""Headerless plain-text adapter: the GW 40K app's *exported* list (no
``++…++`` / ``+ FACTION KEYWORD:`` summary fence), the NewRecruit "copy as
text" dialect, and the markdown-ish ``## Section (N pts)`` shape hand-authored
lists use. All three share one body grammar; they differ only in cosmetic
framing, so a single lenient parser covers them.

Shape (any of)::

    <list name> (1995 Points)            ← title line (consumed, not a unit)
    World Eaters                         ← faction (bare preamble line)
    Berzerker Warband                    ← detachment (bare preamble line)
    Strike Force (2,000 Points)          ← battle-size metadata

    CHARACTERS                           ← ALL-CAPS role section …
    ## Battleline (200 pts)              ← … or `##` markdown section …
    Epic Hero:                           ← … or `Title:` colon section

    Khârn the Betrayer (100 Points)      ← unit header: Name (N pts|Points)
      • Warlord                          ← annotation
      • 1x Gorechild                     ← Nx wargear (single-model unit)
      • Enhancements: Berzerker Glaive   ← enhancement
    Khorne Berzerkers (180 Points)
      • 9x Khorne Berzerker              ← model group (has ◦ children) …
         ◦ 8x Bolt pistol                ← … children are squad-wide wargear
      • 4x Intercessor: Bolt rifle       ← model group (colon wargear, no children)

**Model vs wargear** (the crux), unified across dialects: a model group is a
bulleted entry, at the shallowest model indent, that is followed by a *deeper
bulleted* line (its squad-wide wargear); its ``Nx`` count (default 1) adds to
the model count. Keying on the child being *bulleted* keeps a lone bulleted
weapon trailed by unbulleted continuation lines (a Fire Prism's ``Prism
cannon``) as wargear, not a model. A bullet with a ``: wargear`` colon is also
a model group. Everything else is wargear — a ``Nx``/bare item, or the GW
app's unbulleted continuation lines (v2.0.5 bullets only the *first* weapon
under a model and emits the rest unbulleted, one indent deeper) — or an
annotation (``Warlord``, ``… Character``, ``Enhancements: …``,
``Attached as: …``).

**Disjointness**: this adapter is the fallback for bullet-bearing text that
the framed adapters reject — it declines input carrying the GW
``+ FACTION KEYWORD:`` fence (→ :mod:`wh40kdc.imports.gw`), the NewRecruit
``# ++ Army Roster ++`` header (→ newrecruit-simple), or WTC ``N with`` body
lines, and requires at least one ``•``/``◦`` bullet.

Python mirror of ``tools/src/import/gw-headerless.ts``.
"""

from __future__ import annotations

import re
from typing import Any

from wh40kdc.imports.adapter import FormatAdapter
from wh40kdc.imports.newrecruit_text import infer_battle_size_raw

_CHARACTERS_SECTION = "CHARACTERS"
_ALLIED_SECTION = "ALLIED UNITS"
_CHARACTER_SUFFIX = " Character"
_WARLORD_MARKER = "Warlord"

# Title / unit header: `Name (N pts|Points)` with an optional trailing comment
# (the GW export sometimes appends TO notes). Points may carry thousands
# commas. Case-insensitive `pts`/`points`.
_RE_PTS_LINE = re.compile(r"^(.+?)\s*\(\s*([\d,]+)\s*(?:pts?|points?)\s*\).*$", re.IGNORECASE)
# `## Section [ (N pts) ]` markdown header.
_RE_MD_SECTION = re.compile(r"^#{1,6}\s*(.+?)\s*$")
# ALL-CAPS role section (`CHARACTERS`, `OTHER DATASHEETS`, …).
_RE_CAPS_SECTION = re.compile(r"^[A-Z][A-Z0-9 \-/&]+$")
# `Title:` colon section (`Epic Hero:`, `Battleline:`).
_RE_COLON_SECTION = re.compile(r"^([A-Za-z][\w /&-]*):\s*$")
# Bullet line: leading indent, a `•` or `◦` marker, then the body.
_RE_BULLET = re.compile(r"^([\t ]*)[•◦]\s*(.+?)\s*$")
_RE_NX_PREFIX = re.compile(r"^(\d+)x\s+(.+)$", re.IGNORECASE)
# Inline enhancement annotation: `Name (+N pts)`.
_RE_ENHANCEMENT_ANNOT = re.compile(r"^(.+?)\s*\(\+\s*(\d+)\s*pts?\s*\)\s*$", re.IGNORECASE)
# `Enhancements: X` / `E: X` enhancement bullet.
_RE_ENHANCEMENT_LABEL = re.compile(
    r"^(?:e|enh|enhancement|enhancements)\s*:\s*(.+)$", re.IGNORECASE
)
# Attachment relationship annotations emitted by GW-family exports.
_RE_ATTACHMENT = re.compile(r"^(attached\s+as|leader|leading)\s*:\s*(.+)$", re.IGNORECASE)
# `(Character)` inside an attachment role.
_RE_CHARACTER_ROLE = re.compile(r"\(\s*Character\s*\)", re.IGNORECASE)
_RE_WITH_LINE = re.compile(r"^[\t ]*\d+\s+with\b", re.MULTILINE)
_RE_BULLET_ANYWHERE = re.compile(r"^[\t ]*[•◦]", re.MULTILINE)
# ListForge-text first line: `<name> - <faction> - <detachment> (N Points)`.
# Used only to *decline* — that framed header belongs to
# ``listforge_text_adapter``, which runs ahead of us; declining keeps the
# matchers mutually exclusive.
_RE_LISTFORGE_FIRST_LINE = re.compile(r"^(.+)\s\(\s*\d+\s*Points?\s*\)\s*$", re.IGNORECASE)
# The GW app (v2.0.4+) suffixes the detachment line with its cost —
# "Awakened Dynasty (3 Detachment Points)" — which is presentation, not part
# of the name.
_RE_DETACHMENT_POINTS_SUFFIX = re.compile(r"\s*\(\d+\s+Detachment Points?\)\s*$", re.IGNORECASE)

_SPLIT_LINES = re.compile(r"\r?\n")

# Battle-size labels that look like unit headers (`Strike Force (2,000 Points)`)
# but are army metadata, not datasheets.
_BATTLE_SIZE_NAMES = frozenset({"combat patrol", "incursion", "strike force", "onslaught"})

# A line of only `+` characters — the BCP summary block's fence.
_RE_PLUS_FENCE = re.compile(r"^\++$")
# A line inside that block identifying it as BCP's (not GW's own `+ …` fence).
_RE_BCP_SUMMARY_MARKER = re.compile(
    r"^\s*(?:Player Name|Team Name|Factions Used|Army Points)\s*:", re.IGNORECASE | re.MULTILINE
)


def _parse_pts(raw: str) -> int | None:
    try:
        return int(raw.replace(",", ""))
    except ValueError:
        return None


def _strip_bcp_summary(text: str) -> str:
    """BCP prepends a ``++…++``-fenced summary block (``Player Name:`` /
    ``Factions Used:`` / ``Army Points: N`` / …) to text-type lists. It is
    BCP metadata, not part of the pasted roster, and it derails the body
    grammar: the fence line gets consumed as the roster title, so the *real*
    title line becomes a phantom unit and its points double the computed
    total. Strip the leading block when present. Only a block whose fence pair
    wraps a BCP marker is removed, so a framed GW export's own
    ``+ FACTION KEYWORD:`` fence is left intact."""
    lines = _SPLIT_LINES.split(text)
    open_idx = 0
    while open_idx < len(lines) and lines[open_idx].strip() == "":
        open_idx += 1
    if open_idx >= len(lines) or not _RE_PLUS_FENCE.match(lines[open_idx].strip()):
        return text
    close = -1
    for j in range(open_idx + 1, len(lines)):
        if _RE_PLUS_FENCE.match(lines[j].strip()):
            close = j
            break
    if close == -1:
        return text
    block = "\n".join(lines[open_idx + 1 : close])
    if _RE_BCP_SUMMARY_MARKER.search(block) is None:
        return text
    return "\n".join(lines[close + 1 :])


def _headerless_text(decoded: Any) -> str | None:
    """Accept bullet-bearing plain text that no framed adapter claims."""
    if not isinstance(decoded, str):
        return None
    text = _strip_bcp_summary(decoded)
    if _RE_BULLET_ANYWHERE.search(text) is None:
        return None  # need a bullet
    if "+ FACTION KEYWORD:" in text:
        return None  # framed GW → gw_adapter
    if _RE_WITH_LINE.search(text) is not None:
        return None  # WTC-full
    lines = _SPLIT_LINES.split(text)
    # ListForge-text's `name - faction - detachment (N Points)` header → defer
    # to listforge_text_adapter (registered ahead of us). Mirrors its own
    # matcher so the two stay disjoint, per the importer's single-match
    # invariant.
    first_non_blank = next((line for line in lines if line.strip()), None)
    if first_non_blank is not None:
        lf = _RE_LISTFORGE_FIRST_LINE.match(first_non_blank.strip())
        if lf and len(lf.group(1).split(" - ")) >= 3:
            return None
    # NewRecruit `# ++ Army Roster ++` → newrecruit-simple.
    for line in lines:
        t = line.strip()
        if t.startswith("# ++") and "Army Roster" in t:
            return None
    # Require a `Name (N pts|Points)` line somewhere — the unit/title signature.
    if any(_RE_PTS_LINE.match(line.strip()) for line in lines):
        return text
    return None


def _parse_bullet(indent: int, body: str, bulleted: bool) -> dict[str, Any]:
    base: dict[str, Any] = {
        "indent": indent,
        "bulleted": bulleted,
        "is_attachment": False,
        "sets_character": False,
    }

    # Attachment relationship metadata is never a model or wargear. Catch it
    # before the generic colon split: otherwise `Leader: Character Name`
    # becomes an inline model and inflates the bodyguard's model count by one.
    attachment = _RE_ATTACHMENT.match(body)
    if attachment:
        return {
            **base,
            "count": None,
            "name": "",
            "colon_wargear": None,
            "is_annotation": True,
            "enhancement": None,
            "is_attachment": True,
            "sets_character": (
                attachment.group(1).lower().startswith("attached")
                and _RE_CHARACTER_ROLE.search(attachment.group(2)) is not None
            ),
        }

    # Enhancement label first — `Enhancements: X` must not read as a model.
    label = _RE_ENHANCEMENT_LABEL.match(body)
    if label:
        return {
            **base,
            "count": None,
            "name": "",
            "colon_wargear": None,
            "is_annotation": True,
            "enhancement": (label.group(1).strip(), None),
        }

    nx = _RE_NX_PREFIX.match(body)
    count = int(nx.group(1)) if nx else None
    rest = (nx.group(2) if nx else body).strip()

    # `Name (+N pts)` enhancement annotation.
    annot = _RE_ENHANCEMENT_ANNOT.match(rest)
    if annot:
        return {
            **base,
            "count": count,
            "name": rest,
            "colon_wargear": None,
            "is_annotation": True,
            "enhancement": (annot.group(1).strip(), int(annot.group(2))),
        }

    # `ModelType: w1, w2` — a model bullet with inline wargear.
    idx = rest.find(":")
    if idx >= 0:
        wargear = rest[idx + 1 :].strip()
        return {
            **base,
            "count": count,
            "name": rest[:idx].strip(),
            "colon_wargear": wargear if wargear else None,
            "is_annotation": False,
            "enhancement": None,
        }

    # Bare token: annotation iff it has no count (Warlord / Character / wargear).
    return {
        **base,
        "count": count,
        "name": rest,
        "colon_wargear": None,
        "is_annotation": count is None,
        "enhancement": None,
    }


def _finish_unit(acc: dict[str, Any]) -> dict[str, Any]:
    bullets: list[dict[str, Any]] = acc["bullets"]

    # Models live at the shallowest *bulleted* indent that isn't an annotation,
    # enhancement, or colon-wargear line. The GW v2.0.5 export prefixes each
    # unit with an `Attached as:` bullet shallower than the models, so the old
    # "min of all indents" would misplace the model level — filter those out.
    model_eligible = [
        b
        for b in bullets
        if b["bulleted"]
        and not b["is_attachment"]
        and not b["enhancement"]
        and b["colon_wargear"] is None
    ]
    model_indent = min((b["indent"] for b in model_eligible), default=0)

    # A model group: a bulleted entry at the model indent that is followed by a
    # *deeper bulleted* line (its squad-wide wargear). Keying on the child being
    # bulleted keeps a lone bulleted weapon trailed by plain continuation lines
    # (Fire Prism's Prism cannon) as wargear, not a model. A count-less model
    # name (`• Bloodreaper` with children) still counts as one model.
    def is_model_group(b: dict[str, Any], nxt: dict[str, Any] | None) -> bool:
        return (
            b["bulleted"]
            and b["colon_wargear"] is None
            and not b["enhancement"]
            and not b["is_attachment"]
            and b["indent"] == model_indent
            and nxt is not None
            and nxt["bulleted"]
            and nxt["indent"] > b["indent"]
        )

    wargear: dict[str, int] = {}

    def add_wargear(raw_name: str, count: int) -> None:
        name = raw_name.strip()
        if not name:
            return
        wargear[name] = wargear.get(name, 0) + count

    model_count = 0
    is_warlord = False
    is_character = acc["is_character_section"]
    enhancement_raw_name: str | None = None
    enhancement_points: int | None = None

    for i, b in enumerate(bullets):
        # `Attached as: …` carries no model or gear; a `(Character)` role flags
        # the unit as a character. Skip before model detection — it sits
        # shallower than the models and would otherwise read as a model group.
        if b["is_attachment"]:
            if b["sets_character"]:
                is_character = True
            continue

        # Enhancement annotation (`Enhancements: X` or `X (+N pts)`).
        if b["enhancement"]:
            if enhancement_raw_name is None:
                enhancement_raw_name = b["enhancement"][0]
                enhancement_points = b["enhancement"][1]
            continue

        # Model with inline `: wargear` (the `##`/fixture dialect).
        if b["colon_wargear"] is not None:
            n = b["count"] if b["count"] is not None else 1
            model_count += n
            for item in (s.strip() for s in b["colon_wargear"].split(",")):
                if item:
                    add_wargear(item, n)
            continue

        # Model group: counted bullet at the model indent with a deeper
        # bulleted child.
        nxt = bullets[i + 1] if i + 1 < len(bullets) else None
        if is_model_group(b, nxt):
            model_count += b["count"] if b["count"] is not None else 1
            continue

        # Annotation (no count): Warlord / Character flags, else bare wargear.
        if b["is_annotation"]:
            leftover: list[str] = []
            for token in (t.strip() for t in b["name"].split(",")):
                if not token:
                    continue
                if token == _WARLORD_MARKER:
                    is_warlord = True
                elif token.endswith(_CHARACTER_SUFFIX):
                    is_character = True
                else:
                    leftover.append(token)
            for token in leftover:
                add_wargear(token, 1)
            continue

        # Everything else is wargear — a bulleted weapon under a model or an
        # unbulleted continuation line, at any depth.
        add_wargear(b["name"], b["count"] if b["count"] is not None else 1)

    if model_count == 0:
        model_count = 1

    displayed = acc["displayed_pts"]
    if displayed is not None and enhancement_points is not None:
        points: int | None = max(0, displayed - enhancement_points)
    else:
        points = displayed

    return {
        "raw_name": acc["raw_name"],
        "is_character": is_character,
        "model_count": model_count,
        "points": points,
        "is_warlord": is_warlord,
        "enhancement_raw_name": enhancement_raw_name,
        "enhancement_points": enhancement_points,
        "wargear": [{"raw_name": n, "count": c} for n, c in wargear.items()],
    }


def _is_battle_size(name: str) -> bool:
    return name.strip().lower() in _BATTLE_SIZE_NAMES


def _matches(decoded: Any) -> bool:
    return _headerless_text(decoded) is not None


def _parse(decoded: Any) -> dict[str, Any]:
    text = _headerless_text(decoded)
    if text is None:
        raise ValueError("gw-headerless: not a headerless plain-text list")

    name = "Imported roster"
    declared_limit: int | None = None
    battle_size_raw: str | None = None
    units: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    section: str | None = None
    allied = 0
    consumed_title = False
    # The GW app export lists faction then detachment as bare lines between the
    # title and the first section (`World Eaters` / `Berzerker Warband`).
    # Capture the first two so `resolve` can scope to them; later bare lines
    # (stray notes) are ignored.
    faction_raw_name: str | None = None
    detachment_raw_names: list[str] = []

    def flush() -> None:
        nonlocal current
        if current is not None:
            units.append(_finish_unit(current))
            current = None

    for raw_line in text.split("\n"):
        raw = raw_line.rstrip("\r")
        line = raw.strip()
        if not line:
            continue

        # Bullets attach to the open unit.
        bullet = _RE_BULLET.match(raw)
        if bullet:
            if current is not None:
                current["bullets"].append(
                    _parse_bullet(len(bullet.group(1)), bullet.group(2), True)
                )
            continue

        # GW export footer.
        if line.startswith("Exported with"):
            continue

        # The GW app bullets only the first wargear line under a model and emits
        # the rest unbulleted, one indent deeper (`      4x Shuriken pistol`).
        # Capture those `Nx …` continuation lines as the open unit's wargear at
        # their real indent so `_finish_unit` can place them. A unit header also
        # lacks a bullet but carries a `(N pts)` parenthetical, so it is
        # excluded here and handled just below.
        nx = _RE_NX_PREFIX.match(line)
        if current is not None and nx and not _RE_PTS_LINE.match(line):
            indent = len(raw) - len(raw.lstrip())
            current["bullets"].append(_parse_bullet(indent, line, False))
            continue

        # `## Section` markdown header (strip an optional `(N pts)` tail).
        md = _RE_MD_SECTION.match(line)
        if md:
            flush()
            pts = _RE_PTS_LINE.match(md.group(1))
            section = pts.group(1).strip() if pts else md.group(1).strip()
            continue

        # First `Name (N pts|Points)` line is the roster title, not a unit.
        pts = _RE_PTS_LINE.match(line)
        if pts:
            header_name = pts.group(1).strip()
            points = _parse_pts(pts.group(2))
            if not consumed_title and current is None and not units:
                consumed_title = True
                name = header_name
                declared_limit = points
                continue
            # Some event exports prepend participant/team/faction lines without
            # a fence. Recover their actual high-point roster title instead of
            # emitting it as a phantom unit.
            if (
                declared_limit is None
                and current is None
                and not units
                and len(detachment_raw_names) == 1
                and (points or 0) >= 1000
            ):
                name = header_name
                declared_limit = points
                faction_raw_name = detachment_raw_names.pop()
                continue
            # Battle-size metadata (`Strike Force (2,000 Points)`).
            if _is_battle_size(header_name):
                battle_size_raw = line
                if declared_limit is None:
                    declared_limit = points
                continue
            # A real unit header.
            flush()
            in_chars = section is not None and section.lower() == _CHARACTERS_SECTION.lower()
            if section == _ALLIED_SECTION:
                allied += 1
            current = {
                "raw_name": header_name,
                "displayed_pts": points,
                "is_character_section": in_chars,
                "bullets": [],
            }
            continue

        # Section headers without points (ALL-CAPS role, `Title:` colon).
        if _RE_CAPS_SECTION.match(line) or _RE_COLON_SECTION.match(line):
            flush()
            section = re.sub(r":\s*$", "", line).strip()
            continue

        # Anything else (faction/detachment preamble, stray notes).
        if not consumed_title and current is None and not units:
            # Very first content line with no `(N pts)` title → use as name.
            consumed_title = True
            name = line
        elif current is None and not units:
            # Preamble after the title, before the first unit: faction then
            # detachment. Names are resolved (and warned on miss) downstream.
            # The GW app (v2.0.4+) suffixes the detachment line with its cost —
            # "Awakened Dynasty (3 Detachment Points)" — which is presentation,
            # not part of the name; strip it so resolution sees the bare name.
            if faction_raw_name is None:
                faction_raw_name = line
            elif not detachment_raw_names:
                detachment_raw_names.append(_RE_DETACHMENT_POINTS_SUFFIX.sub("", line))

    flush()

    total_computed = 0
    for u in units:
        total_computed += (u["points"] or 0) + (u["enhancement_points"] or 0)

    return {
        "name": name,
        "generated_by": None,
        "faction_raw_name": faction_raw_name,
        "detachment_raw_names": detachment_raw_names,
        "battle_size_raw": battle_size_raw
        if battle_size_raw is not None
        else infer_battle_size_raw(declared_limit),
        "declared_limit": declared_limit,
        "total_reported": None,
        "total_computed": total_computed,
        "units": units,
        "multi_force": allied > 0,
    }


gw_headerless_adapter = FormatAdapter(id="gw", matches=_matches, parse=_parse)
