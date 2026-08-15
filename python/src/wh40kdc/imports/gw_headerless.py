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
from wh40kdc.imports.newrecruit_text import (
    classify_wargear_list,
    infer_battle_size_raw,
    split_wargear_list,
)

_CHARACTERS_SECTION = "CHARACTERS"
_ALLIED_SECTION = "ALLIED UNITS"
_CHARACTER_SUFFIX = " Character"
_WARLORD_MARKER = "Warlord"

# Title / unit header: `Name (N pts|Points)` with an optional trailing comment.
# Event exports use commas, periods, apostrophes, ordinary spaces, NBSP, and
# narrow NBSP as thousands separators.
_RE_PTS_LINE = re.compile(
    r"^(.+?)\s*\(\s*([\d,.'’\u00a0\u202f ]+)\s*(?:pts?|points?)\s*\).*$",
    re.IGNORECASE,
)
_RE_MD_SECTION = re.compile(r"^#{1,6}\s*(.+?)\s*$")
_RE_CAPS_SECTION = re.compile(r"^[A-Z][A-Z0-9 \-/&]+$")
_RE_COLON_SECTION = re.compile(r"^([A-Za-z][\w /&-]*):\s*$")
_RE_BULLET = re.compile(r"^([\t \u00a0]*)([•◦*])\s*(.+?)\s*$")
_RE_NX_PREFIX = re.compile(r"^(\d+)[x×]\s+(.+)$", re.IGNORECASE)
_RE_MODEL_WITH_WARGEAR = re.compile(r"^(\d+)(?:[x×]\s+|\s+)(.+?)\s+with\s+(.+)$", re.IGNORECASE)
_RE_BARE_POINTS_LINE = re.compile(
    r"^\(?\s*([\d,.'’\u00a0\u202f ]+)\s*(?:pts?|points?)\s*\)?$", re.IGNORECASE
)
_RE_ENHANCEMENT_ANNOT = re.compile(
    r"^(.+?)\s*(?:\(\+\s*(\d+)\s*pts?\s*\)|\[\+\s*(\d+)\s*(?:pts?|points?)\s*\])\s*$",
    re.IGNORECASE,
)
_RE_ENHANCEMENT_LABEL = re.compile(
    r"^(?:e|enh|enhancement|enhancements|verbesserung|verbesserungen)\s*:\s*(.+)$",
    re.IGNORECASE,
)
_RE_ATTACHMENT = re.compile(r"^(attached\s+as|leader|leading)\s*:\s*(.+)$", re.IGNORECASE)
_RE_CHARACTER_ROLE = re.compile(r"\(\s*Character\s*\)", re.IGNORECASE)
_RE_CHARACTER_ANNOTATION = re.compile(
    r"^(?:.+\s+keywords?\s*:\s*character|subterranean\s+assault\s+character)$",
    re.IGNORECASE,
)
_RE_COLON_ANNOTATION = re.compile(
    r"^(?:.+\s+keywords?|mark of chaos|daemonic allegiance)\s*:", re.IGNORECASE
)
_RE_KEYWORD_ANNOTATION = re.compile(r"^This Datasheet also has the (.+?) keyword$", re.IGNORECASE)
_RE_WITH_LINE = re.compile(r"^[\t ]*\d+\s+with\b", re.MULTILINE)
_RE_BULLET_ANYWHERE = re.compile(r"^[\t \u00a0]*[•◦*]", re.MULTILINE)
_RE_LISTFORGE_FIRST_LINE = re.compile(
    r"^(.+)\s\(\s*[\d,.'’\u00a0\u202f ]+\s*Points?\s*\)\s*$", re.IGNORECASE
)
_BATTLE_SIZE_NAMES = frozenset(
    {"combat patrol", "incursion", "strike force", "onslaught", "strikeforce"}
)
_FORCE_DISPOSITION_NAMES = frozenset(
    {"disruption", "priority assets", "purge the foe", "reconnaissance", "recon", "take and hold"}
)
_GENERIC_FACTION_BREADCRUMBS = frozenset({"chaos", "imperium", "space marines", "xenos"})
_RE_BODY_SECTION = re.compile(
    r"^(?:CHARACTERS|BATTLELINE|DEDICATED TRANSPORTS|"
    r"OTHER DATASHEETS|ALLIED UNITS|FORTIFICATIONS)$",
    re.IGNORECASE,
)
_RE_DETACHMENT_POINTS_SUFFIX = re.compile(
    r"\s*\(\s*\d*\s*(?:Detachment Points?|Detachementpoints?|DP|PD)\s*\)\s*$",
    re.IGNORECASE,
)
_RE_ATTACHED_SECTION = re.compile(r"^attached units?(?:\s+\d+)?$", re.IGNORECASE)
_RE_PLUS_FENCE = re.compile(r"^\++$")
_RE_BCP_SUMMARY_MARKER = re.compile(
    r"^\s*\+?\s*(?:Player Name|Team Name|Factions? Used|Army Points)\s*:",
    re.IGNORECASE | re.MULTILINE,
)
_RE_BCP_WARLORD = re.compile(r"^\s*\+?\s*WARLORD:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_RE_EMBEDDED_APP_BATTLE_SIZE = re.compile(
    r"^\s*(?:Combat Patrol|Incursion|Strike Force|Onslaught)\s*\(\s*[\d.,]+\s*Points?\s*\)\s*$",
    re.IGNORECASE | re.MULTILINE,
)

_SPLIT_LINES = re.compile(r"\r?\n")


def _parse_pts(raw: str) -> int | None:
    digits = re.sub(r"\D", "", raw)
    return int(digits) if digits else None


def _strip_bcp_summary(text: str) -> str:
    lines = _SPLIT_LINES.split(text)
    try:
        open_idx = next(i for i, line in enumerate(lines) if _RE_PLUS_FENCE.match(line.strip()))
    except StopIteration:
        return text
    close = next(
        (i for i in range(open_idx + 1, len(lines)) if _RE_PLUS_FENCE.match(lines[i].strip())),
        -1,
    )
    if close == -1:
        return text
    block = "\n".join(lines[open_idx + 1 : close])
    remainder = "\n".join(lines[close + 1 :])
    if (
        _RE_BCP_SUMMARY_MARKER.search(block) is None
        and _RE_EMBEDDED_APP_BATTLE_SIZE.search(remainder) is None
    ):
        return text
    return "\n".join([*lines[:open_idx], *lines[close + 1 :]])


def _expand_dense_lines(text: str) -> list[str]:
    out: list[str] = []
    for raw_line in _SPLIT_LINES.split(text):
        for bullet_part in re.split(r"(?<=\S)[\t \u00a0]+(?=[•◦]\s*)", raw_line):
            headings = re.match(
                r"^(Attached Units)\s+(Attached Unit\s+\d+)$", bullet_part.strip(), re.IGNORECASE
            )
            if headings:
                out.extend(headings.groups())
                continue
            metadata = re.match(
                r"^(.+?\(\s*\d+\s+Detachment Points?\s*\))\s+"
                r"(Disruption|Priority Assets|Purge the Foe|Reconnaissance|Take and Hold)\s+"
                r"((?:Combat Patrol|Incursion|Strike Force|Onslaught)\s*\(.+\))$",
                bullet_part.strip(),
                re.IGNORECASE,
            )
            if metadata:
                out.extend(metadata.groups())
                continue
            for part in re.split(r"(?<=[^\s•◦*])[\t \u00a0]+(?=\d+[x×]\s)", bullet_part):
                leading_bullet = re.match(r"^[•◦]\s*(.+)$", part.strip())
                out.append(
                    leading_bullet.group(1)
                    if leading_bullet and _RE_PTS_LINE.match(leading_bullet.group(1))
                    else part
                )
    return out


def _headerless_text(decoded: Any) -> str | None:
    """Accept bullet-bearing plain text that no framed adapter claims."""
    if not isinstance(decoded, str):
        return None
    if (
        "+ FACTION KEYWORD:" in decoded
        and "+ NUMBER OF UNITS:" in decoded
        and _RE_EMBEDDED_APP_BATTLE_SIZE.search(decoded) is None
    ):
        return None
    text = _strip_bcp_summary(decoded)
    if _RE_BULLET_ANYWHERE.search(text) is None:
        return None
    if "+ FACTION KEYWORD:" in text and _RE_EMBEDDED_APP_BATTLE_SIZE.search(text) is None:
        return None
    if _RE_WITH_LINE.search(text) is not None:
        return None
    lines = _SPLIT_LINES.split(text)
    first_non_blank = next((line for line in lines if line.strip()), None)
    if first_non_blank is not None:
        lf = _RE_LISTFORGE_FIRST_LINE.match(first_non_blank.strip())
        if lf and len(lf.group(1).split(" - ")) >= 3:
            return None
    if any(line.strip().startswith("# ++") and "Army Roster" in line.strip() for line in lines):
        return None
    return text if any(_RE_PTS_LINE.match(line.strip()) for line in lines) else None


def _parse_bullet(indent: int, body: str, bulleted: bool) -> dict[str, Any]:
    base: dict[str, Any] = {
        "indent": indent,
        "bulleted": bulleted,
        "is_attachment": False,
        "sets_character": False,
        "keyword_override": None,
        "attachment_role": None,
    }
    attachment = _RE_ATTACHMENT.match(body)
    if attachment:
        attached_as = attachment.group(1).lower() == "attached as"
        role = re.match(r"^(leader|support|bodyguard)\b", attachment.group(2), re.IGNORECASE)
        return {
            **base,
            "count": None,
            "name": "",
            "colon_wargear": None,
            "is_annotation": True,
            "enhancement": None,
            "is_attachment": True,
            "sets_character": attached_as
            and _RE_CHARACTER_ROLE.search(attachment.group(2)) is not None,
            "attachment_role": role.group(1).lower() if attached_as and role else None,
        }
    if _RE_CHARACTER_ANNOTATION.match(body.strip()):
        return {
            **base,
            "count": None,
            "name": "",
            "colon_wargear": None,
            "is_annotation": True,
            "enhancement": None,
            "sets_character": True,
            "keyword_override": "Character",
        }
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
    annot = _RE_ENHANCEMENT_ANNOT.match(rest)
    if annot:
        return {
            **base,
            "count": count,
            "name": rest,
            "colon_wargear": None,
            "is_annotation": True,
            "enhancement": (annot.group(1).strip(), int(annot.group(2) or annot.group(3))),
        }
    model_with_wargear = _RE_MODEL_WITH_WARGEAR.match(rest)
    if model_with_wargear:
        wargear = model_with_wargear.group(3)
        if "," in wargear:
            wargear = re.sub(r"\s+and\s+(?=[^,]+$)", ", ", wargear, flags=re.IGNORECASE)
        return {
            **base,
            "count": int(model_with_wargear.group(1)),
            "name": model_with_wargear.group(2).strip(),
            "colon_wargear": wargear.strip(),
            "is_annotation": False,
            "enhancement": None,
        }
    if count is None:
        plain_count = re.match(r"^(\d+)\s+(.+)$", rest)
        if plain_count:
            count, rest = int(plain_count.group(1)), plain_count.group(2).strip()
    keyword = _RE_KEYWORD_ANNOTATION.match(rest)
    if _RE_CHARACTER_ANNOTATION.match(rest) or keyword:
        return {
            **base,
            "count": None,
            "name": "",
            "colon_wargear": None,
            "is_annotation": True,
            "enhancement": None,
            "sets_character": _RE_CHARACTER_ANNOTATION.match(rest) is not None,
            "keyword_override": keyword.group(1).strip() if keyword else "Character",
        }
    if _RE_COLON_ANNOTATION.match(rest):
        keyword_value = rest[rest.index(":") + 1 :].strip()
        return {
            **base,
            "count": None,
            "name": "",
            "colon_wargear": None,
            "is_annotation": True,
            "enhancement": None,
            "keyword_override": keyword_value or None,
        }
    idx = rest.find(":")
    if idx >= 0:
        wargear = rest[idx + 1 :].strip()
        return {
            **base,
            "count": count,
            "name": rest[:idx].strip(),
            "colon_wargear": wargear or None,
            "is_annotation": False,
            "enhancement": None,
        }
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
        and not b["sets_character"]
        and not b["enhancement"]
        and b["name"] != _WARLORD_MARKER
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
            and not b["sets_character"]
            and b["name"] != _WARLORD_MARKER
            and b["indent"] == model_indent
            and nxt is not None
            and nxt["bulleted"]
            and nxt["indent"] > b["indent"]
        )

    wargear: dict[str, int] = {}
    keyword_overrides: set[str] = set()
    loadout_groups: list[dict[str, Any]] = []

    def add_wargear(raw_name: str, count: int) -> None:
        name = raw_name.strip()
        if name:
            wargear[name] = wargear.get(name, 0) + count

    model_count = 0
    is_warlord = False
    is_character = acc["is_character_section"]
    enhancement_raw_name: str | None = None
    enhancement_points: int | None = None

    for i, b in enumerate(bullets):
        if b.get("keyword_override"):
            keyword_overrides.add(b["keyword_override"])
        if b["sets_character"]:
            is_character = True
            continue
        if b["is_attachment"]:
            continue
        if b["enhancement"]:
            if enhancement_raw_name is None:
                enhancement_raw_name, enhancement_points = b["enhancement"]
            continue
        if b["colon_wargear"] is not None:
            n = b["count"] if b["count"] is not None else 1
            model_count += n
            classified = classify_wargear_list(split_wargear_list(b["colon_wargear"]))
            for item in classified["wargear"]:
                add_wargear(item["raw_name"], item["count"] * n)
            loadout_groups.append(
                {
                    "model_name": b["name"],
                    "count": n,
                    "wargear": classified["wargear"],
                }
            )
            continue
        nxt = bullets[i + 1] if i + 1 < len(bullets) else None
        if is_model_group(b, nxt):
            n = b["count"] if b["count"] is not None else 1
            model_count += n
            group_wargear: list[dict[str, Any]] = []
            exact = True
            for child in bullets[i + 1 :]:
                if child["indent"] <= b["indent"]:
                    break
                if (
                    child["is_attachment"]
                    or child["sets_character"]
                    or child["enhancement"]
                    or child["is_annotation"]
                    or child["colon_wargear"] is not None
                ):
                    exact = False
                    continue
                total = child["count"] if child["count"] is not None else 1
                if total % n:
                    exact = False
                    continue
                group_wargear.append({"raw_name": child["name"], "count": total // n})
            if exact and group_wargear:
                loadout_groups.append(
                    {"model_name": b["name"], "count": n, "wargear": group_wargear}
                )
            continue
        if b["is_annotation"]:
            for token in (t.strip() for t in b["name"].split(",")):
                if token == _WARLORD_MARKER:
                    is_warlord = True
                elif token.endswith(_CHARACTER_SUFFIX):
                    is_character = True
                elif token:
                    add_wargear(token, 1)
            continue
        add_wargear(b["name"], b["count"] if b["count"] is not None else 1)

    if model_count == 0:
        model_count = 1

    displayed = acc["displayed_pts"]
    if displayed is not None and enhancement_points is not None:
        points: int | None = max(0, displayed - enhancement_points)
    else:
        points = displayed

    grouped_counts: dict[str, int] = {}
    for group in loadout_groups:
        for item in group["wargear"]:
            grouped_counts[item["raw_name"]] = (
                grouped_counts.get(item["raw_name"], 0) + item["count"] * group["count"]
            )
    exact_groups = (
        sum(group["count"] for group in loadout_groups) == model_count
        and len(grouped_counts) == len(wargear)
        and all(grouped_counts.get(name) == count for name, count in wargear.items())
    )
    return {
        "raw_name": acc["raw_name"],
        "is_character": is_character,
        "model_count": model_count,
        "points": points,
        "is_warlord": is_warlord,
        "enhancement_raw_name": enhancement_raw_name,
        **({"keyword_overrides": list(keyword_overrides)} if keyword_overrides else {}),
        "enhancement_points": enhancement_points,
        "wargear": [{"raw_name": n, "count": c} for n, c in wargear.items()],
        **({"loadout_groups": loadout_groups} if exact_groups else {}),
    }


def _is_battle_size(name: str) -> bool:
    return name.strip().lower() in _BATTLE_SIZE_NAMES


def _matches(decoded: Any) -> bool:
    return _headerless_text(decoded) is not None


def _parse(decoded: Any) -> dict[str, Any]:
    text = _headerless_text(decoded)
    if text is None:
        raise ValueError("gw-headerless: not a headerless plain-text list")
    summary_warlord_match = _RE_BCP_WARLORD.search(text)
    summary_warlord = (
        summary_warlord_match.group(1).strip() if summary_warlord_match is not None else None
    )
    name = "Imported roster"
    declared_limit: int | None = None
    total_reported: int | None = None
    battle_size_raw: str | None = None
    faction_raw_name: str | None = None
    force_disposition_raw_name: str | None = None
    units: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    section: str | None = None
    allied = 0
    consumed_title = False
    preamble_open = True
    preamble_lines: list[str] = []
    detachment_raw_names: list[str] = []
    attachment_members: list[tuple[int, int, str]] = []
    attachment_group: int | None = None
    pending_attachment_role: str | None = None

    def close_preamble() -> None:
        nonlocal preamble_open, faction_raw_name, force_disposition_raw_name
        if not preamble_open:
            return
        preamble_open = False
        parts = list(preamble_lines)
        disposition_index = next(
            (i for i, part in enumerate(parts) if part.lower() in _FORCE_DISPOSITION_NAMES), -1
        )
        if disposition_index >= 0:
            if force_disposition_raw_name is None:
                force_disposition_raw_name = parts[disposition_index]
            parts.pop(disposition_index)
        if faction_raw_name is None and parts:
            faction_raw_name = parts.pop(0)
            if len(parts) > 1 and faction_raw_name.lower() in _GENERIC_FACTION_BREADCRUMBS:
                faction_raw_name = parts.pop(0)
        if not detachment_raw_names and parts:
            detachment_raw_names.extend(
                filter(
                    None,
                    (_RE_DETACHMENT_POINTS_SUFFIX.sub("", part) for part in parts),
                )
            )

    def flush() -> None:
        nonlocal current
        if current is not None:
            unit_index = len(units)
            units.append(_finish_unit(current))
            if current["attachment_group"] is not None and current["attachment_role"] is not None:
                attachment_members.append(
                    (unit_index, current["attachment_group"], current["attachment_role"])
                )
            current = None

    for raw_line in _expand_dense_lines(text):
        raw, line = raw_line.rstrip("\r"), raw_line.strip()
        if not line:
            continue
        bullet = _RE_BULLET.match(raw)
        if bullet:
            if current is not None:
                marker_depth = 1 if bullet.group(2) == "◦" else 0
                parsed = _parse_bullet(len(bullet.group(1)) + marker_depth, bullet.group(3), True)
                current["bullets"].append(parsed)
                if current["attachment_role"] is None:
                    current["attachment_role"] = parsed["attachment_role"]
            continue
        if line.startswith("Exported with"):
            continue
        if preamble_open and current is None and not units:
            metadata = re.match(r"^([^:]{1,32}):\s*(.+)$", line)
            if metadata:
                key, value = metadata.group(1).strip().lower(), metadata.group(2).strip()
                if key in {"player", "team"}:
                    continue
                if key == "list name":
                    name, consumed_title = value, True
                    continue
                if key in {"faction", "factions", "faction keyword"}:
                    faction_raw_name, consumed_title = value, True
                    continue
                if re.match(r"^det(?:a|at)chments?$", key):
                    detachment_raw_names.append(_RE_DETACHMENT_POINTS_SUFFIX.sub("", value))
                    consumed_title = True
                    continue
                if re.match(r"^force dispositions?$", key):
                    force_disposition_raw_name = (
                        re.sub(r"\s*\(selected\)\.?\s*$", "", value, flags=re.IGNORECASE)
                        .split(",")[0]
                        .strip()
                    )
                    consumed_title = True
                    continue
                if key == "battle size":
                    battle_size_raw, consumed_title = value, True
                    match = _RE_PTS_LINE.match(value)
                    if match:
                        declared_limit = _parse_pts(match.group(2))
                    continue
        loose_battle_size = re.match(
            r"^(Combat Patrol|Incursion|Strike Force|Onslaught)\b", line, re.IGNORECASE
        )
        if preamble_open and current is None and not units and loose_battle_size:
            battle_size_raw, declared_limit = line, _parse_pts(line)
            if force_disposition_raw_name is not None or any(
                part.lower() in _FORCE_DISPOSITION_NAMES for part in preamble_lines
            ):
                close_preamble()
            continue
        nx = _RE_NX_PREFIX.match(line)
        if current is not None and nx and not _RE_PTS_LINE.match(line):
            current["bullets"].append(_parse_bullet(len(raw) - len(raw.lstrip()), line, False))
            continue
        md = _RE_MD_SECTION.match(line)
        if md:
            close_preamble()
            flush()
            points_header = _RE_PTS_LINE.match(md.group(1))
            section = points_header.group(1).strip() if points_header else md.group(1).strip()
            continue
        bare_points = _RE_BARE_POINTS_LINE.match(line)
        if bare_points:
            if total_reported is None:
                total_reported = _parse_pts(bare_points.group(1))
            consumed_title = True
            continue
        pts = _RE_PTS_LINE.match(line)
        if pts:
            header_name, points = pts.group(1).strip(), _parse_pts(pts.group(2))
            if _is_battle_size(header_name):
                battle_size_raw = line
                if points is not None:
                    declared_limit = points
                continue
            if (
                current is None
                and not units
                and re.search(r"\bDetachment Points?\b", line, re.IGNORECASE)
            ):
                preamble_lines.append(line)
                continue
            if not consumed_title and current is None and not units:
                name, total_reported, consumed_title = header_name, points, True
                continue
            if declared_limit is None and current is None and not units and (points or 0) >= 1000:
                name, total_reported = header_name, points
                del preamble_lines[: -1 if len(preamble_lines) >= 2 else len(preamble_lines)]
                continue
            close_preamble()
            flush()
            if section == _ALLIED_SECTION:
                allied += 1
            current = {
                "raw_name": header_name,
                "displayed_pts": points,
                "is_character_section": section is not None
                and section.lower() == _CHARACTERS_SECTION.lower(),
                "bullets": [],
                "attachment_group": attachment_group,
                "attachment_role": pending_attachment_role,
            }
            pending_attachment_role = None
            continue
        attached_group = re.match(r"^attached unit\s+(\d+)$", line, re.IGNORECASE)
        if attached_group:
            close_preamble()
            flush()
            section = "ATTACHED UNITS"
            attachment_group = int(attached_group.group(1))
            continue
        if re.match(r"^attached as support\s*:?\s*$", line, re.IGNORECASE):
            close_preamble()
            flush()
            pending_attachment_role = "support"
            continue
        if _RE_ATTACHED_SECTION.match(line):
            close_preamble()
            flush()
            section, attachment_group = "ATTACHED UNITS", None
            continue
        if (
            preamble_open
            and current is None
            and not units
            and _RE_CAPS_SECTION.match(line)
            and not _RE_BODY_SECTION.match(line)
        ):
            preamble_lines.append(line)
            continue
        if _RE_CAPS_SECTION.match(line) or _RE_COLON_SECTION.match(line):
            close_preamble()
            flush()
            section = re.sub(r":\s*$", "", line).strip()
            attachment_group = None
            continue
        if preamble_open and re.search(r"https?://", line, re.IGNORECASE):
            continue
        if not consumed_title and current is None and not units:
            name, consumed_title = line, True
        elif preamble_open and current is None and not units:
            preamble_lines.append(line)
    close_preamble()
    flush()
    for group in {member[1] for member in attachment_members}:
        members = [member for member in attachment_members if member[1] == group]
        bodyguard = next((member for member in members if member[2] == "bodyguard"), None)
        if bodyguard:
            for unit_index, _, role in members:
                if role != "bodyguard":
                    units[unit_index]["leader_attachment"] = {
                        "bodyguard_raw_name": units[bodyguard[0]]["raw_name"],
                        "role": role,
                        "provisional": False,
                    }
    if summary_warlord:
        matches = [
            unit for unit in units if unit["raw_name"].lower().startswith(summary_warlord.lower())
        ]
        if len(matches) == 1:
            for unit in units:
                unit["is_warlord"] = False
            matches[0]["is_warlord"] = True
    total_computed = sum(
        (unit["points"] or 0) + (unit["enhancement_points"] or 0) for unit in units
    )
    effective_limit = declared_limit if declared_limit is not None else total_reported
    return {
        "name": name,
        "generated_by": None,
        "faction_raw_name": faction_raw_name,
        "detachment_raw_names": detachment_raw_names,
        "battle_size_raw": battle_size_raw
        if battle_size_raw is not None
        else infer_battle_size_raw(effective_limit),
        "force_disposition_raw_name": force_disposition_raw_name,
        "declared_limit": effective_limit,
        "total_reported": total_reported,
        "total_computed": total_computed,
        "units": units,
        "multi_force": allied > 0,
    }


gw_headerless_adapter = FormatAdapter(id="gw", matches=_matches, parse=_parse)
