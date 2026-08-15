"""The flat ``Buff`` shape every contribution flows through, and the
:func:`resolve_buffs` resolver that collapses a stack into a resolved-modifiers
read-out the engine can consume.

The same shape carries weapon-keyword effects, ability buffs, stratagem
effects, and manual UI toggles — reroll-stacking, hit/wound caps, and
feel-no-pain-best-threshold all fall out of one resolver rather than each
source kind reinventing precedence.

Buffs are plain dicts mirroring the wire shape::

    {"source": {...}, "contribution": {...}, "applicableWhen": {...}?}

Python mirror of ``tools/src/cruncher/buffs.ts``. The resolved-modifiers dict
keeps the TS camelCase field names so the port stays line-comparable.
"""

from __future__ import annotations

import json
from typing import Any

Buff = dict[str, Any]
BuffSource = dict[str, Any]
ResolvedModifiers = dict[str, Any]
EngineContext = dict[str, Any]

#: Stable ordering used to break ties when multiple buffs claim the same field.
_SOURCE_KIND_RANK = {
    "ability:army": 0,
    "ability:detachment": 1,
    "ability:detachment-stratagem": 2,
    "ability:unit": 3,
    "ability:attached": 4,
    "ability:support": 5,
    "manual": 6,
    "weapon-keyword": 7,
}


def _rank(s: BuffSource) -> int:
    if s.get("kind") == "ability":
        return _SOURCE_KIND_RANK.get(f"ability:{s.get('abilityKind')}", 99)
    return _SOURCE_KIND_RANK.get(s.get("kind", ""), 99)


def _applies(buff: Buff, ctx: EngineContext) -> bool:
    w = buff.get("applicableWhen")
    if not w:
        return True
    phases = w.get("phases")
    if phases and ctx.get("phase") not in phases:
        return False
    contribution = buff["contribution"]
    if (
        w.get("rollType")
        and contribution.get("type") == "reroll"
        and contribution.get("roll") != w["rollType"]
    ):
        return False
    if w.get("requiresTargetKeyword"):
        target = ctx.get("targetKeywords") or []
        if w["requiresTargetKeyword"].lower() not in target:
            return False
    if w.get("requiresAttackerKeyword"):
        attacker = ctx.get("attackerKeywords") or []
        if w["requiresAttackerKeyword"].lower() not in attacker:
            return False
    # Range gate: drop only when the distance is known and exceeds the ability's
    # range (DSL scope.range_inches). Unknown distance is permissive.
    max_range = w.get("maxRangeInches")
    distance = ctx.get("distanceInches")
    if max_range is not None and distance is not None and distance > max_range:
        return False
    return True


def _key_of(ref: dict[str, Any]) -> str:
    return f"{ref.get('keyword_id')}::{json.dumps(ref.get('parameters') or {})}"


def resolve_buffs(buffs: list[Buff], ctx: EngineContext) -> ResolvedModifiers:
    """Collapse a flat buff stack into a resolved-modifiers read-out.

    Pure function; the engine — and any UI that wants to render the resolved
    table before crunching — both go through this.
    """
    live = [b for b in buffs if _applies(b, ctx)]

    out: ResolvedModifiers = {
        "hitMod": {"value": 0, "dominantSource": None},
        "woundMod": {"value": 0, "dominantSource": None},
        "saveMod": {"value": 0, "sources": []},
        "cover": {"active": False, "source": None},
        "rerolls": {},
        "extraKeywords": [],
        "feelNoPain": None,
        "feelNoPainMortal": None,
        "damageMod": {"value": 0, "sources": []},
        "attacksMod": {"value": 0, "sources": []},
        "strengthMod": {"value": 0, "sources": []},
        "toughnessMod": {"value": 0, "sources": []},
        "apMod": {"value": 0, "sources": []},
        "damageReduction": {"value": 0, "dominantSource": None},
        "invulnerable": None,
    }

    # Hit / wound mods: sum, then cap at ±1, with dominant source picked from
    # the contributors whose sign matches the surviving value.
    hit_contribs: list[dict[str, Any]] = []
    wound_contribs: list[dict[str, Any]] = []

    for b in live:
        c = b["contribution"]
        ctype = c.get("type")
        source = b["source"]
        if ctype == "hit-mod":
            hit_contribs.append({"value": c["value"], "source": source})
        elif ctype == "wound-mod":
            wound_contribs.append({"value": c["value"], "source": source})
        elif ctype == "save-mod":
            out["saveMod"]["value"] += c["value"]
            out["saveMod"]["sources"].append(source)
        elif ctype == "cover":
            if not out["cover"]["active"] or _rank(source) < _rank(out["cover"]["source"]):
                out["cover"] = {"active": True, "source": source}
        elif ctype == "reroll":
            cur = out["rerolls"].get(c["roll"])
            incoming = c["subset"]
            if cur is None:
                out["rerolls"][c["roll"]] = {"subset": incoming, "dominantSource": source}
            else:
                incoming_stronger = (incoming == "all-failures" and cur["subset"] == "ones") or (
                    incoming == cur["subset"] and _rank(source) < _rank(cur["dominantSource"])
                )
                if incoming_stronger:
                    out["rerolls"][c["roll"]] = {"subset": incoming, "dominantSource": source}
        elif ctype == "extra-keyword":
            key = _key_of(c["keywordRef"])
            if not any(_key_of(e["keywordRef"]) == key for e in out["extraKeywords"]):
                out["extraKeywords"].append({"keywordRef": c["keywordRef"], "source": source})
        elif ctype == "feel-no-pain":
            # Best (lowest) threshold wins per scope. An undeclared scope is
            # treated as "all" — unscoped FNP applies to every wound.
            scope = c.get("scope", "all")
            slot = "feelNoPainMortal" if scope == "mortal" else "feelNoPain"
            if out[slot] is None or c["threshold"] < out[slot]["threshold"]:
                out[slot] = {"threshold": c["threshold"], "dominantSource": source}
        elif ctype == "damage-mod":
            out["damageMod"]["value"] += c["value"]
            out["damageMod"]["sources"].append(source)
        elif ctype == "attacks-mod":
            out["attacksMod"]["value"] += c["value"]
            out["attacksMod"]["sources"].append(source)
        elif ctype == "strength-mod":
            out["strengthMod"]["value"] += c["value"]
            out["strengthMod"]["sources"].append(source)
        elif ctype == "toughness-mod":
            out["toughnessMod"]["value"] += c["value"]
            out["toughnessMod"]["sources"].append(source)
        elif ctype == "ap-mod":
            out["apMod"]["value"] += c["value"]
            out["apMod"]["sources"].append(source)
        elif ctype == "damage-reduction":
            # Highest reduction wins (no stacking). Ties break by source rank
            # for provenance; the resolved value is unchanged either way.
            dr = out["damageReduction"]
            if (
                dr["dominantSource"] is None
                or c["value"] > dr["value"]
                or (c["value"] == dr["value"] and _rank(source) < _rank(dr["dominantSource"]))
            ):
                out["damageReduction"] = {"value": c["value"], "dominantSource": source}
        elif ctype == "invulnerable-save":
            # Best (lowest threshold) wins. Same tie-break by source rank.
            inv = out["invulnerable"]
            if (
                inv is None
                or c["threshold"] < inv["threshold"]
                or (
                    c["threshold"] == inv["threshold"]
                    and _rank(source) < _rank(inv["dominantSource"])
                )
            ):
                out["invulnerable"] = {"threshold": c["threshold"], "dominantSource": source}

    out["hitMod"] = _cap_modifier(hit_contribs)
    out["woundMod"] = _cap_modifier(wound_contribs)

    return out


def _sign(n: float) -> int:
    return (n > 0) - (n < 0)


def _cap_modifier(contribs: list[dict[str, Any]]) -> dict[str, Any]:
    """Sum, clamp to ±1, then pick the dominant contributing source by rank."""
    if not contribs:
        return {"value": 0, "dominantSource": None}
    total = sum(c["value"] for c in contribs)
    capped = max(-1, min(1, total))
    if capped == 0:
        return {"value": 0, "dominantSource": None}
    sign = _sign(capped)
    matching = sorted(
        (c for c in contribs if _sign(c["value"]) == sign),
        key=lambda c: _rank(c["source"]),
    )
    return {
        "value": capped,
        "dominantSource": matching[0]["source"] if matching else None,
    }
