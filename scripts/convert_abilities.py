#!/usr/bin/env python3
"""Convert army-assist ability descriptions into ability DSL JSON.

Usage: python3 scripts/convert_abilities.py

Reads army-assist data from ~/army-assist/src/assets/json/
Writes ability DSL files to data/enrichment/{faction}/abilities.json
Preserves hand-authored data for world-eaters.
Produces a conversion report to stdout listing all unconverted abilities.
"""

import json
import os
import re
import sys
import unicodedata
from pathlib import Path
from collections import defaultdict

REPO = Path(__file__).resolve().parent.parent
ARMY_ASSIST = Path(os.path.expanduser("~/army-assist/src/assets/json"))
ENRICHMENT = REPO / "data" / "enrichment"
GAME_VERSION = {"edition": "10th", "dataslate": "2025-q3"}
AUTHORED_BY = "40kdc-community"

# Factions to skip (hand-authored DSL exists)
PRESERVE_FACTIONS = {"world-eaters"}

# 40kdc faction → army-assist faction code
FACTION_MAP = {
    "adepta-sororitas": "AS",
    "adeptus-astartes": "SM",
    "adeptus-custodes": "AC",
    "adeptus-mechanicus": "AdM",
    "aeldari": "AE",
    "agents-of-the-imperium": "AoI",
    "astra-militarum": "AM",
    "black-templars": "SM",
    "blood-angels": "SM",
    "chaos-daemons": "CD",
    "chaos-knights": "QI",
    "chaos-space-marines": "CSM",
    "crimson-fists": "SM",
    "dark-angels": "SM",
    "death-guard": "DG",
    "deathwatch": "SM",
    "drukhari": "DRU",
    "emperors-children": "EC",
    "genestealer-cults": "GC",
    "grey-knights": "GK",
    "imperial-fists": "SM",
    "imperial-knights": "QT",
    "iron-hands": "SM",
    "leagues-of-votann": "LoV",
    "necrons": "NEC",
    "orks": "ORK",
    "raven-guard": "SM",
    "salamanders": "SM",
    "space-wolves": "SM",
    "tau-empire": "TAU",
    "thousand-sons": "TS",
    "tyranids": "TYR",
    "ultramarines": "SM",
    "white-scars": "SM",
    "world-eaters": "WE",
}


def name_to_id(name: str) -> str:
    s = unicodedata.normalize("NFD", name)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def resolve_dice(val) -> float:
    if isinstance(val, (int, float)):
        return float(val)
    if not val:
        return 0.0
    s = str(val).strip().upper()
    m = re.match(r"^(\d*)D(\d+)\s*([+-]\s*\d+)?$", s)
    if m:
        count = int(m.group(1)) if m.group(1) else 1
        sides = int(m.group(2))
        bonus = int(m.group(3).replace(" ", "")) if m.group(3) else 0
        return count * (sides + 1) / 2.0 + bonus
    try:
        return float(s)
    except ValueError:
        return 0.0


def make_ability(
    ability_id, name, effect, scope, unit_ids=None, faction_id=None,
    detachment_id=None, ability_type="unit", behavior="passive",
    community_notes=None, confidence="high",
):
    """Build a valid ability DSL entry."""
    ab = {
        "ability_id": ability_id,
        "name": name,
        "authored_by": AUTHORED_BY,
        "game_version": GAME_VERSION,
        "version": GAME_VERSION["dataslate"],
        "effect": effect,
        "scope": scope,
    }
    if unit_ids:
        ab["unit_ids"] = unit_ids
    if faction_id:
        ab["faction_id"] = faction_id
    if detachment_id:
        ab["detachment_id"] = detachment_id
    if ability_type:
        ab["ability_type"] = ability_type
    if behavior:
        ab["behavior"] = behavior
    if community_notes:
        ab["community_notes"] = community_notes
    return ab, confidence


# ---------------------------------------------------------------------------
# TIER 1: Template abilities (exact name match)
# ---------------------------------------------------------------------------

def parse_tier1(name, param, ab_type):
    """Try to match a well-known ability by name. Returns (effect, scope, behavior, ability_type) or None."""
    name_lower = name.lower().strip()

    if name_lower == "leader":
        return (
            {"type": "ability-grant", "target": "unit", "modifier": {"ability_id": "leader"}},
            {"range": "attached", "duration": "permanent"},
            "passive", "core",
        )

    if name_lower == "deep strike":
        return (
            {"type": "deep-strike", "target": "unit", "modifier": {}},
            {"range": "unit", "duration": "permanent"},
            "activated", "core",
        )

    if "deadly demise" in name_lower:
        dmg_val = param if param else "1"
        return (
            {
                "type": "dice-gated",
                "dice": "D6",
                "threshold": 6,
                "comparison": "gte",
                "on_success": {
                    "type": "mortal-wounds",
                    "target": "enemy-within-aura",
                    "modifier": {"count": dmg_val, "range": 6},
                },
                "on_fail": None,
            },
            {"range": "aura-6", "duration": "one-use"},
            "reactive", "core",
        )

    if "feel no pain" in name_lower:
        threshold = 6
        if param:
            m = re.search(r"(\d+)", str(param))
            if m:
                threshold = int(m.group(1))
        return (
            {"type": "feel-no-pain", "target": "unit", "modifier": {"threshold": threshold}},
            {"range": "unit", "duration": "permanent"},
            "passive", "core",
        )

    if name_lower == "stealth":
        return (
            {
                "type": "roll-modifier",
                "target": "attacker",
                "modifier": {"roll": "hit", "operation": "subtract", "value": 1},
            },
            {"range": "unit", "duration": "permanent"},
            "passive", "core",
        )

    if name_lower == "infiltrators":
        return (
            {"type": "movement-modifier", "target": "unit", "modifier": {"type": "infiltrate"}},
            {"range": "unit", "duration": "one-use"},
            "activated", "core",
        )

    if name_lower == "lone operative":
        return (
            {"type": "attack-restriction", "target": "self", "modifier": {"restriction": "cannot-be-targeted-unless-closest-or-within-12"}},
            {"range": "self", "duration": "permanent"},
            "passive", "core",
        )

    if name_lower == "hover":
        return (
            {"type": "stat-modifier", "target": "self", "modifier": {"stat": "M", "operation": "set", "value": 20}},
            {"range": "self", "duration": "permanent"},
            "activated", "core",
        )

    if "scouts" in name_lower:
        distance = 6
        if param:
            m = re.search(r"(\d+)", str(param))
            if m:
                distance = int(m.group(1))
        return (
            {"type": "movement-modifier", "target": "unit", "modifier": {"type": "scouts", "distance": distance}},
            {"range": "unit", "duration": "one-use"},
            "activated", "core",
        )

    if "firing deck" in name_lower:
        capacity = 2
        if param:
            m = re.search(r"(\d+)", str(param))
            if m:
                capacity = int(m.group(1))
        return (
            {"type": "ability-grant", "target": "unit", "modifier": {"ability_id": "firing-deck", "capacity": capacity}},
            {"range": "self", "duration": "permanent"},
            "passive", "core",
        )

    if name_lower == "super-heavy walker":
        return (
            {"type": "ability-grant", "target": "self", "modifier": {"ability_id": "super-heavy-walker"}},
            {"range": "self", "duration": "permanent"},
            "passive", "core",
        )

    return None


# ---------------------------------------------------------------------------
# TIER 2: Pattern-parsed abilities
# ---------------------------------------------------------------------------

def _normalize(text):
    """Normalize Unicode dashes to ASCII and lowercase."""
    return text.lower().replace('\u2011', '-').replace('\u2010', '-').replace('\u2013', '-').replace('\u2014', '-')


def classify_offense_defense(desc):
    """Determine if an ability is offensive or defensive based on description text."""
    d = _normalize(desc)
    # Offensive indicators: "makes an attack", "shooting phase" (your), "fight phase" (your)
    offensive = any(p in d for p in [
        "makes an attack", "selected to shoot", "selected to fight",
        "attacks characteristic", "hit roll", "wound roll",
        "armour penetration", "strength characteristic", "damage characteristic",
        "mortal wound", "lethal hits", "sustained hits", "devastating wounds",
    ])
    # Defensive indicators: "attack targets this unit", "saving throw", "invulnerable"
    defensive = any(p in d for p in [
        "targets this unit", "targets that unit", "allocated to this model",
        "would lose a wound", "saving throw", "invulnerable save",
        "subtract 1 from the hit roll",  # enemy hit roll
    ])
    # "subtract from wound roll" is ambiguous — check context
    if "subtract" in d and "wound roll" in d:
        if "targets this" in d or "allocated to" in d:
            defensive = True
        else:
            offensive = True
    return "offensive" if offensive and not defensive else "defensive" if defensive else "unknown"


def extract_conditions(desc):
    """Extract conditions from description text, return list of condition nodes."""
    d = _normalize(desc)
    conditions = []

    if "fight phase" in d or "melee attack" in d:
        conditions.append({"type": "phase-is", "parameters": {"phase": "fight"}})
    elif "shooting phase" in d or "ranged attack" in d:
        conditions.append({"type": "phase-is", "parameters": {"phase": "shooting"}})

    if "charged this turn" in d or "made a charge move" in d:
        conditions.append({"type": "charged-this-turn"})
    if "remained stationary" in d:
        conditions.append({"type": "remained-stationary"})
    if "below its starting strength" in d or "below starting strength" in d:
        conditions.append({"type": "unit-below-starting-strength"})
    if "below half-strength" in d or "below half strength" in d:
        conditions.append({"type": "unit-below-half-strength"})
    if "is leading" in d or "while leading" in d or "attached to" in d:
        conditions.append({"type": "is-attached"})

    # Target keyword conditions
    for kw_match in re.finditer(r"targets?\s+(?:a\s+|an\s+)?(\w+)\s+unit", d):
        kw = kw_match.group(1).upper()
        if kw not in ("THIS", "THAT", "THE", "ONE", "ENEMY", "FRIENDLY"):
            conditions.append({"type": "target-has-keyword", "parameters": {"keyword": kw}})

    return conditions


def extract_scope(desc):
    """Extract scope from description text."""
    d = _normalize(desc)
    duration = "permanent"
    if "until the end of the phase" in d:
        duration = "phase"
    elif "until the end of the turn" in d:
        duration = "turn"
    elif "until the start of your next command phase" in d:
        duration = "until-next-command-phase"
    elif "once per battle" in d:
        duration = "one-use"

    scope_range = "unit"
    m = re.search(r"within (\d+)\"", d)
    if m:
        inches = int(m.group(1))
        if inches <= 6:
            scope_range = "aura-6"
        elif inches <= 9:
            scope_range = "aura-9"
        elif inches <= 12:
            scope_range = "aura-12"
        else:
            scope_range = "aura-custom"

    scope = {"range": scope_range, "duration": duration}
    if scope_range == "aura-custom" and m:
        scope["range_inches"] = int(m.group(1))
    return scope


def parse_tier2(name, desc, ab_type):
    """Try to extract a structured effect from the description text.
    Returns (effect, scope, behavior, confidence) or None.
    """
    if not desc:
        return None

    # Normalize Unicode dashes (U+2011, U+2010, U+2013, U+2014) to ASCII hyphen
    d = desc.lower().replace('\u2011', '-').replace('\u2010', '-').replace('\u2013', '-').replace('\u2014', '-')
    effects = []
    confidence = "high"

    # --- Rerolls ---
    if re.search(r"re-roll[^.]*hit rolls? of 1", d):
        effects.append({"type": "re-roll", "target": "unit", "modifier": {"roll": "hit", "condition": "natural-1"}})
    elif re.search(r"re-roll[^.]*(?:the |all )?hit rolls(?! of [12])", d) or re.search(r"can re-roll the hit roll(?! of)", d):
        effects.append({"type": "re-roll", "target": "unit", "modifier": {"roll": "hit", "condition": "any-fail"}})
    if re.search(r"re-roll[^.]*wound rolls? of 1", d):
        effects.append({"type": "re-roll", "target": "unit", "modifier": {"roll": "wound", "condition": "natural-1"}})
    elif re.search(r"re-roll[^.]*(?:the |all )?wound rolls(?! of [12])", d) or re.search(r"can re-roll the wound roll(?! of)", d):
        effects.append({"type": "re-roll", "target": "unit", "modifier": {"roll": "wound", "condition": "any-fail"}})
    if re.search(r"re-roll[^.]*(?:the |all )?damage roll", d):
        effects.append({"type": "re-roll", "target": "unit", "modifier": {"roll": "damage", "condition": "any-fail"}})
    if re.search(r"re-roll[^.]*charge roll", d):
        effects.append({"type": "re-roll", "target": "unit", "modifier": {"roll": "charge", "condition": "any-fail"}})

    # --- Roll modifiers ---
    m = re.search(r"add (\d+) to[^.]*hit roll", d)
    if m:
        effects.append({"type": "roll-modifier", "target": "unit", "modifier": {"roll": "hit", "operation": "add", "value": int(m.group(1))}})
    m = re.search(r"subtract (\d+) from[^.]*hit roll", d)
    if m and classify_offense_defense(desc) == "offensive":
        effects.append({"type": "roll-modifier", "target": "attacker", "modifier": {"roll": "hit", "operation": "subtract", "value": int(m.group(1))}})
    m = re.search(r"add (\d+) to[^.]*wound roll", d)
    if m:
        effects.append({"type": "roll-modifier", "target": "unit", "modifier": {"roll": "wound", "operation": "add", "value": int(m.group(1))}})
    m = re.search(r"subtract (\d+) from[^.]*wound roll", d)
    if m and classify_offense_defense(desc) == "offensive":
        effects.append({"type": "roll-modifier", "target": "unit", "modifier": {"roll": "wound", "operation": "subtract", "value": int(m.group(1))}})

    # --- Stat modifiers ---
    m = re.search(r"add (\d+) to the[^.]*attacks characteristic", d)
    if m:
        effects.append({"type": "stat-modifier", "target": "unit", "modifier": {"stat": "A", "operation": "add", "value": int(m.group(1))}})
    m = re.search(r"add (\d+) to the[^.]*strength characteristic", d)
    if m:
        effects.append({"type": "stat-modifier", "target": "unit", "modifier": {"stat": "S", "operation": "add", "value": int(m.group(1))}})
    m = re.search(r"improve[^.]*armour penetration[^.]*by (\d+)", d)
    if m:
        effects.append({"type": "stat-modifier", "target": "unit", "modifier": {"stat": "AP", "operation": "add", "value": -int(m.group(1))}})
    m = re.search(r"subtract (\d+) from the damage characteristic", d)
    if m:
        effects.append({"type": "damage-reduction", "target": "unit", "modifier": {"reduction": int(m.group(1))}})

    # --- Keyword grants ---
    if re.search(r"\[?lethal hits\]?", d):
        effects.append({"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Lethal Hits"]}})
    m = re.search(r"\[?sustained hits (\d+)\]?", d)
    if m:
        effects.append({"type": "keyword-grant", "target": "unit", "modifier": {"keywords": [f"Sustained Hits {m.group(1)}"]}})
    if re.search(r"\[?devastating wounds\]?", d):
        effects.append({"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Devastating Wounds"]}})
    if re.search(r"\[?precision\]?", d) and "precision" not in name.lower():
        effects.append({"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Precision"]}})
    if re.search(r"\[?ignores cover\]?", d):
        effects.append({"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Ignores Cover"]}})

    # --- Invulnerable save ---
    m = re.search(r"invulnerable save[^.]*?(\d+)\+", d)
    if m:
        effects.append({"type": "invulnerable-save", "target": "unit", "modifier": {"invuln_sv": int(m.group(1))}})

    # --- Feel No Pain (in descriptions, not name) ---
    m = re.search(r"feel no pain (\d+)\+", d)
    if m:
        effects.append({"type": "feel-no-pain", "target": "unit", "modifier": {"threshold": int(m.group(1))}})

    # --- Fight first ---
    if re.search(r"fights? first", d):
        effects.append({"type": "fight-first", "target": "unit", "modifier": {}})

    # --- Mortal wounds output ---
    m = re.search(r"(?:suffers?|inflicts?) (\d+|d\d+) mortal wounds?", d)
    if m:
        count = m.group(1)
        effects.append({"type": "mortal-wounds", "target": "defender", "modifier": {"count": count}})

    # --- Fight/shoot on death ---
    if re.search(r"(?:fight|attack)[^.]*(?:after|before)[^.]*(?:destroyed|removed)", d):
        effects.append({"type": "fight-on-death", "target": "self", "modifier": {}})
    if re.search(r"shoot[^.]*(?:after|before)[^.]*(?:destroyed|removed)", d):
        effects.append({"type": "shoot-on-death", "target": "self", "modifier": {}})

    # --- Resurrection ---
    m = re.search(r"return[^.]*?(\d+|d\d+)[^.]*destroyed model", d)
    if m:
        effects.append({"type": "resurrection", "target": "unit", "modifier": {"count": m.group(1)}})

    # --- Toughness reduction on enemies (effective +wound) ---
    if re.search(r"subtract \d+ from[^.]*toughness characteristic", d):
        m2 = re.search(r"subtract (\d+) from[^.]*toughness characteristic", d)
        if m2:
            effects.append({"type": "stat-modifier", "target": "enemy-within-aura", "modifier": {"stat": "T", "operation": "subtract", "value": int(m2.group(1))}})

    # --- EXPANDED PATTERNS (Phase 2 additions) ---

    # Defensive: subtract from hit/wound roll when attacks TARGET this unit
    if not effects:
        m = re.search(r"(?:attack[^.]*targets? this|targets? (?:this|that) unit)[^.]*subtract (\d+) from[^.]*(?:hit|wound) roll", d)
        if m:
            roll = "hit" if "hit roll" in d[m.start():] else "wound"
            effects.append({"type": "roll-modifier", "target": "attacker",
                           "modifier": {"roll": roll, "operation": "subtract", "value": int(m.group(1))}})
        # Also catch: "subtract 1 from the Hit roll" when context is clearly defensive
        if not effects and re.search(r"subtract (\d+) from[^.]*hit roll", d):
            if classify_offense_defense(desc) == "defensive":
                m = re.search(r"subtract (\d+) from[^.]*hit roll", d)
                effects.append({"type": "roll-modifier", "target": "attacker",
                               "modifier": {"roll": "hit", "operation": "subtract", "value": int(m.group(1))}})
        if not effects and re.search(r"subtract (\d+) from[^.]*wound roll", d):
            if classify_offense_defense(desc) == "defensive":
                m = re.search(r"subtract (\d+) from[^.]*wound roll", d)
                effects.append({"type": "roll-modifier", "target": "attacker",
                               "modifier": {"roll": "wound", "operation": "subtract", "value": int(m.group(1))}})

    # Halve Damage characteristic
    if not effects and re.search(r"halve the damage characteristic", d):
        effects.append({"type": "damage-reduction", "target": "unit", "modifier": {"reduction": "half"}})

    # Change Damage to 0 (once per battle damage negation)
    if not effects and re.search(r"change the damage characteristic[^.]*to 0", d):
        effects.append({"type": "damage-reduction", "target": "self", "modifier": {"reduction": "to-zero"}})

    # Improve Strength AND Damage characteristics
    if not effects:
        m = re.search(r"improve the strength and damage characteristic[^.]*by (\d+)", d)
        if m:
            val = int(m.group(1))
            effects.append({"type": "stat-modifier", "target": "unit", "modifier": {"stat": "S", "operation": "add", "value": val}})
            effects.append({"type": "stat-modifier", "target": "unit", "modifier": {"stat": "D", "operation": "add", "value": val}})

    # Eligible to charge after Advancing
    if not effects and re.search(r"eligible to declare a charge[^.]*(?:advanced|advance)", d):
        effects.append({"type": "ability-grant", "target": "unit", "modifier": {"ability_id": "charge-after-advance"}})

    # Eligible to shoot/fight after Falling Back
    if not effects and re.search(r"(?:shoot|fight)[^.]*(?:fell back|fall back)", d):
        effects.append({"type": "fallback-and-act", "target": "unit", "modifier": {}})
    if not effects and re.search(r"eligible to (?:shoot|fight)[^.]*(?:fell back|fallen back)", d):
        effects.append({"type": "fallback-and-act", "target": "unit", "modifier": {}})

    # Regain lost wounds
    if not effects:
        m = re.search(r"regain[^.]*?(\d+|d\d+)[^.]*lost wounds?", d)
        if m:
            effects.append({"type": "resurrection", "target": "self", "modifier": {"count": m.group(1), "type": "wounds"}})

    # Return destroyed models
    if not effects:
        m = re.search(r"return[^.]*?(\d+|d\d+)[^.]*destroyed", d)
        if m:
            effects.append({"type": "resurrection", "target": "unit", "modifier": {"count": m.group(1), "type": "models"}})

    # Battle-shock test imposition
    if not effects and re.search(r"must take a battle-shock test", d):
        effects.append({"type": "leadership-modifier", "target": "enemy-within-aura", "modifier": {"test": "battle-shock"}})

    # CP refund / stratagem discount
    if not effects:
        if re.search(r"(?:fire overwatch|heroic intervention)[^.]*0\s*cp", d):
            effects.append({"type": "cp-refund", "target": "self", "modifier": {"stratagem": "fire-overwatch-or-heroic"}})
        elif re.search(r"(?:gain|gains?) (\d+)\s*cp", d):
            m = re.search(r"(?:gain|gains?) (\d+)\s*cp", d)
            effects.append({"type": "cp-gain", "target": "self", "modifier": {"amount": int(m.group(1))}})
        elif re.search(r"(?:reduce|reducing)[^.]*cp cost[^.]*by (\d+)", d):
            m = re.search(r"(?:reduce|reducing)[^.]*cp cost[^.]*by (\d+)", d)
            effects.append({"type": "cp-refund", "target": "self", "modifier": {"amount": int(m.group(1))}})

    # Ignore modifiers to hit/wound/characteristics
    if not effects and re.search(r"ignore any or all modifiers", d):
        effects.append({"type": "roll-modifier", "target": "unit", "modifier": {"roll": "all", "operation": "ignore-modifiers"}})

    # Fire Overwatch on improved threshold
    if not effects:
        m = re.search(r"(?:fire overwatch|overwatch)[^.]*(?:unmodified )?(?:hit rolls? of )?(\d)\+", d)
        if m:
            effects.append({"type": "roll-modifier", "target": "unit",
                           "modifier": {"roll": "hit", "operation": "set", "value": int(m.group(1)), "context": "overwatch"}})

    # Benefit of Cover
    if not effects and re.search(r"benefit of cover", d):
        effects.append({"type": "ability-grant", "target": "unit", "modifier": {"ability_id": "benefit-of-cover"}})

    # Sticky objectives
    if not effects and re.search(r"(?:objective marker|objective)[^.]*remains under your control", d):
        effects.append({"type": "objective-control-modifier", "target": "unit", "modifier": {"sticky": True}})

    # Must be WARLORD
    if not effects and re.search(r"must be your warlord", d):
        effects.append({"type": "attack-restriction", "target": "self", "modifier": {"restriction": "must-be-warlord"}})

    # Transport disembark rules
    if not effects and re.search(r"disembark[^.]*(?:after|before)[^.]*(?:advanced|normal move|charge)", d):
        effects.append({"type": "ability-grant", "target": "unit", "modifier": {"ability_id": "transport-disembark-modifier"}})

    # Movement over terrain/models
    if not effects and re.search(r"move over (?:friendly |enemy )?(?:models|terrain)", d):
        effects.append({"type": "movement-modifier", "target": "self", "modifier": {"type": "move-over-terrain"}})

    # Reinforcement denial
    if not effects and re.search(r"reinforcements cannot be set up within", d):
        m = re.search(r"cannot be set up within (\d+)", d)
        dist = int(m.group(1)) if m else 12
        effects.append({"type": "attack-restriction", "target": "enemy-within-aura",
                        "modifier": {"restriction": "reinforcement-denial", "range": dist}})

    # Post-shooting debuff (enemy loses cover, gets -1 to hit, etc.)
    if not effects and re.search(r"(?:after|shooting phase)[^.]*(?:shot|shot at)[^.]*(?:cannot have|does not have)[^.]*benefit of cover", d):
        effects.append({"type": "keyword-grant", "target": "defender",
                        "modifier": {"keywords": ["loses-cover"], "context": "post-shooting-debuff"}})

    # Set a characteristic to a specific value
    if not effects:
        m = re.search(r"(?:has|have) a (\w+) characteristic of (\d+)", d)
        if m:
            stat_name = m.group(1).capitalize()
            stat_map = {"Move": "M", "Save": "Sv", "Strength": "S", "Toughness": "T",
                       "Wounds": "W", "Leadership": "Ld", "Attacks": "A"}
            stat = stat_map.get(stat_name, stat_name)
            effects.append({"type": "stat-modifier", "target": "self",
                           "modifier": {"stat": stat, "operation": "set", "value": int(m.group(2))}})

    # Astartes shield / invulnerable save from wargear description
    if not effects:
        m = re.search(r"(?:bearer|model)[^.]*(\d+)\+\s*invulnerable save", d)
        if m:
            effects.append({"type": "invulnerable-save", "target": "self", "modifier": {"invuln_sv": int(m.group(1))}})

    # OC modifier (halve, set to 0, etc.)
    if not effects and re.search(r"(?:halve|half)[^.]*objective control", d):
        effects.append({"type": "objective-control-modifier", "target": "enemy-within-aura",
                        "modifier": {"operation": "halve"}})

    # Add X to OC characteristic
    if not effects:
        m = re.search(r"add (\d+) to the objective control characteristic", d)
        if m:
            effects.append({"type": "objective-control-modifier", "target": "unit",
                           "modifier": {"operation": "add", "value": int(m.group(1))}})

    # Reactive move when enemy ends move within X"
    if not effects and re.search(r"(?:when|each time)[^.]*enemy unit[^.]*ends? a[^.]*move[^.]*within", d):
        effects.append({"type": "movement-modifier", "target": "unit",
                        "modifier": {"type": "reactive-move", "trigger": "enemy-ends-move-nearby"}})

    # Anti-fallback (enemy within engagement can't fall back, or triggers on fallback)
    if not effects and re.search(r"(?:within engagement range|engagement range)[^.]*falls? back", d):
        effects.append({"type": "attack-restriction", "target": "enemy-within-aura",
                        "modifier": {"restriction": "anti-fallback"}})

    # Bearer has SMOKE/GRENADES keyword
    if not effects and re.search(r"bearer has the (\w+) keyword", d):
        m = re.search(r"bearer has the (\w+) keyword", d)
        effects.append({"type": "keyword-grant", "target": "self",
                        "modifier": {"keywords": [m.group(1).capitalize()]}})

    # Ranged/melee weapons have [KEYWORD] ability
    if not effects:
        m = re.search(r"(?:ranged|melee) weapons[^.]*have the \[([^\]]+)\]", d)
        if m:
            effects.append({"type": "keyword-grant", "target": "unit",
                           "modifier": {"keywords": [m.group(1)]}})

    # Conditional re-roll: "re-roll a X roll of 1. If [condition], re-roll the X roll instead"
    if not effects:
        m = re.search(r"re-roll[^.]*(?:hit|wound) rolls? of 1[^.]*re-roll the (?:hit|wound) roll instead", d)
        if m:
            roll = "hit" if "hit roll instead" in d else "wound"
            effects.append({"type": "re-roll", "target": "unit",
                           "modifier": {"roll": roll, "condition": "any-fail"}})

    # Re-roll Damage when allocated to MONSTER/VEHICLE
    if not effects and re.search(r"re-roll[^.]*damage roll", d):
        effects.append({"type": "re-roll", "target": "unit",
                        "modifier": {"roll": "damage", "condition": "any-fail"}})

    # Advance move is fixed distance (don't roll)
    if not effects and re.search(r"(?:do not|don't) make an advance roll[^.]*instead[^.]*(\d+)", d):
        m = re.search(r"instead[^.]*(\d+)", d)
        if m:
            effects.append({"type": "movement-modifier", "target": "unit",
                           "modifier": {"type": "fixed-advance", "distance": int(m.group(1))}})

    # Skyleap / redeploy to reserves at end of turn
    if not effects and re.search(r"(?:end of|at the end)[^.]*(?:opponent.s? turn|your turn)[^.]*(?:remove|place)[^.]*(?:reserves|strategic reserves)", d):
        effects.append({"type": "movement-modifier", "target": "unit",
                        "modifier": {"type": "redeploy-to-reserves"}})

    # Start battle in Reserves (transport/deep strike variant)
    if not effects and re.search(r"must start the battle in reserves", d):
        effects.append({"type": "deep-strike", "target": "unit", "modifier": {"type": "start-in-reserves"}})

    # Can shoot/fight even if unit arrived from reserves
    if not effects and re.search(r"(?:shoot|fight)[^.]*(?:arriving|arrived|set up)[^.]*(?:reserves|reinforcement)", d):
        effects.append({"type": "ability-grant", "target": "unit",
                        "modifier": {"ability_id": "act-after-reserves"}})

    # Suppression / debuff after shooting
    if not effects and re.search(r"(?:after|has shot)[^.]*(?:select one enemy|enemy unit)[^.]*(?:suppress|cannot|subtract|worsen)", d):
        effects.append({"type": "leadership-modifier", "target": "defender",
                        "modifier": {"type": "post-shooting-debuff"}})

    # Unstoppable / come back on death roll
    if not effects and re.search(r"(?:first time|destroyed)[^.]*roll[^.]*d6[^.]*(?:set up|regain|return)", d):
        effects.append({"type": "resurrection", "target": "self",
                        "modifier": {"type": "revive-on-death", "condition": "dice-roll"}})

    # WARLORD restriction (this model must be warlord / cannot be warlord)
    if not effects and re.search(r"cannot be your warlord", d):
        effects.append({"type": "attack-restriction", "target": "self",
                        "modifier": {"restriction": "cannot-be-warlord"}})

    # Faction rules about army composition (not a game effect)
    if not effects and re.search(r"(?:when mustering|you cannot include|cannot select)", d):
        effects.append({"type": "attack-restriction", "target": "self",
                        "modifier": {"restriction": "army-composition-rule"}})

    # Attached Unit eligibility
    if not effects and re.search(r"(?:can be attached to this unit|attached to a|leader ability can be attached)", d):
        effects.append({"type": "ability-grant", "target": "unit",
                        "modifier": {"ability_id": "attached-unit-eligibility"}})

    # --- SUPER SAIYANS (once-per-battle spike abilities) ---

    # "Once per battle" stat spike: improve Attacks/Strength/Damage
    if not effects and re.search(r"once per battle", d):
        stat_effects = []
        # +X to Attacks characteristic
        m = re.search(r"(?:add|improve)[^.]*?(\d+)[^.]*attacks characteristic", d)
        if m:
            stat_effects.append({"type": "stat-modifier", "target": "unit",
                                "modifier": {"stat": "A", "operation": "add", "value": int(m.group(1))}})
        # +X to Strength characteristic
        m = re.search(r"(?:add|improve)[^.]*?(\d+)[^.]*strength characteristic", d)
        if m or re.search(r"improve the (?:attacks and )?strength", d):
            val = int(m.group(1)) if m else 1
            stat_effects.append({"type": "stat-modifier", "target": "unit",
                                "modifier": {"stat": "S", "operation": "add", "value": val}})
        # Improve Strength and Attacks
        m = re.search(r"improve the attacks and strength characteristic[^.]*by (\d+)", d)
        if m:
            val = int(m.group(1))
            stat_effects = [
                {"type": "stat-modifier", "target": "unit", "modifier": {"stat": "A", "operation": "add", "value": val}},
                {"type": "stat-modifier", "target": "unit", "modifier": {"stat": "S", "operation": "add", "value": val}},
            ]
        # Triple Attacks and Strength (Orikan the Diviner)
        if re.search(r"triple the attacks and strength", d):
            stat_effects = [
                {"type": "stat-modifier", "target": "self", "modifier": {"stat": "A", "operation": "multiply", "value": 3}},
                {"type": "stat-modifier", "target": "self", "modifier": {"stat": "S", "operation": "multiply", "value": 3}},
            ]
        # Keyword grants in once-per-battle
        if re.search(r"\[?devastating wounds\]?", d):
            stat_effects.append({"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Devastating Wounds"]}})
        if re.search(r"\[?lethal hits\]?", d):
            stat_effects.append({"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Lethal Hits"]}})
        m_sh = re.search(r"\[?sustained hits (\d+)\]?", d)
        if m_sh:
            stat_effects.append({"type": "keyword-grant", "target": "unit", "modifier": {"keywords": [f"Sustained Hits {m_sh.group(1)}"]}})

        if stat_effects:
            if len(stat_effects) == 1:
                effects = stat_effects
            else:
                effects.append({"type": "sequence", "steps": stat_effects})

    # "Once per battle" shoot again / fight again
    if not effects and re.search(r"once per battle", d):
        if re.search(r"(?:has shot|has fought)[^.]*(?:shoot|fight) again", d) or re.search(r"after[^.]*shot[^.]*it can shoot again", d):
            effects.append({"type": "ability-grant", "target": "unit",
                           "modifier": {"ability_id": "shoot-again"}})

    # "Once per battle" change roll to unmodified 6
    if not effects and re.search(r"once per battle", d):
        if re.search(r"change[^.]*(?:result|roll)[^.]*(?:to (?:an )?unmodified 6|to a 6)", d):
            effects.append({"type": "roll-modifier", "target": "self",
                           "modifier": {"roll": "any", "operation": "set", "value": 6, "uses": 1}})
        # Change result of one Hit/Wound/Damage roll
        if not effects and re.search(r"change the result of one (?:hit|wound|damage) roll", d):
            effects.append({"type": "roll-modifier", "target": "self",
                           "modifier": {"roll": "any", "operation": "set", "value": 6, "uses": 1}})

    # "Once per battle" remove Battle-shock (appears ~12 times across factions)
    if not effects and re.search(r"once per battle", d):
        if re.search(r"battle-shocked[^.]*within[^.]*that unit is no longer battle-shocked", d):
            effects.append({"type": "leadership-modifier", "target": "friendly-within-aura",
                           "modifier": {"type": "remove-battle-shock"}})

    # "Once per battle" Stratagem for 0CP
    if not effects and re.search(r"once per battle", d):
        if re.search(r"(?:target|use)[^.]*stratagem[^.]*0\s*cp", d):
            effects.append({"type": "cp-refund", "target": "self",
                           "modifier": {"type": "stratagem-for-0cp"}})

    # "Once per battle" Resurrection Orb
    if not effects and re.search(r"once per battle", d):
        if re.search(r"resurrect|reanimate|return[^.]*destroyed", d):
            effects.append({"type": "resurrection", "target": "unit",
                           "modifier": {"type": "once-per-battle"}})

    # "Once per battle" gain resource (CP, Miracle dice)
    if not effects and re.search(r"once per battle", d):
        if re.search(r"gain[^.]*(?:\d+\s*cp|miracle dic|command point)", d):
            effects.append({"type": "cp-gain", "target": "self",
                           "modifier": {"type": "once-per-battle-resource"}})

    # "Once per battle" catch-all for remaining
    if not effects and re.search(r"once per battle", d):
        # At minimum, capture as an activated ability with the best-effort effect
        effects.append({"type": "ability-grant", "target": "unit",
                        "modifier": {"ability_id": "once-per-battle-special"}})

    # --- Post-shooting/fighting debuffs on enemy ---
    # "after this unit/model has shot, select one enemy unit hit... until end of phase/turn"
    if not effects and re.search(r"(?:after|has shot|has fought)[^.]*select one enemy unit[^.]*(?:hit|targeted)", d):
        # Try to parse the debuff effect
        debuff_effects = []
        if re.search(r"cannot have the benefit of cover", d):
            debuff_effects.append({"type": "keyword-grant", "target": "defender",
                                  "modifier": {"keywords": ["loses-cover"]}})
        if re.search(r"suppress|subtract \d+ from[^.]*hit roll", d):
            debuff_effects.append({"type": "roll-modifier", "target": "defender",
                                  "modifier": {"roll": "hit", "operation": "subtract", "value": 1}})
        if re.search(r"battle-shock test", d):
            debuff_effects.append({"type": "leadership-modifier", "target": "defender",
                                  "modifier": {"test": "battle-shock"}})
        if re.search(r"improve[^.]*armour penetration", d):
            debuff_effects.append({"type": "stat-modifier", "target": "defender",
                                  "modifier": {"stat": "AP", "operation": "improve-for-allies"}})
        if debuff_effects:
            effects = debuff_effects
        else:
            effects.append({"type": "ability-grant", "target": "defender",
                           "modifier": {"ability_id": "post-attack-debuff"}})

    # --- Once-per-battle-round variants ---
    if not effects and re.search(r"once per (?:battle round|turn)", d):
        if re.search(r"battle-shocked[^.]*no longer battle-shocked", d):
            effects.append({"type": "leadership-modifier", "target": "friendly-within-aura",
                           "modifier": {"type": "remove-battle-shock"}})
        elif re.search(r"select one order", d):
            effects.append({"type": "ability-grant", "target": "unit",
                           "modifier": {"ability_id": "extra-order"}})
        elif re.search(r"change[^.]*result[^.]*(?:to (?:an )?unmodified 6|to a 6)", d):
            effects.append({"type": "roll-modifier", "target": "self",
                           "modifier": {"roll": "any", "operation": "set", "value": 6}})
        elif re.search(r"stratagem[^.]*0\s*cp", d):
            effects.append({"type": "cp-refund", "target": "self",
                           "modifier": {"type": "stratagem-for-0cp"}})
        else:
            effects.append({"type": "ability-grant", "target": "unit",
                           "modifier": {"ability_id": "once-per-round-special"}})

    # --- BATCH 3: Patterns from stubs 52-100 review ---

    # Shoot-and-scoot: after shooting, can make a Normal move
    if not effects and re.search(r"after[^.]*(?:has shot|shot)[^.]*(?:can make|it can make) a normal move", d):
        effects.append({"type": "movement-modifier", "target": "unit",
                        "modifier": {"type": "shoot-and-scoot"}})

    # Can target within Engagement Range (Siege Shield, Line-breaker)
    if not effects and re.search(r"(?:can target|target)[^.]*(?:within engagement range|engagement range of it)", d):
        effects.append({"type": "ability-grant", "target": "self",
                        "modifier": {"ability_id": "target-in-engagement"}})

    # Combat Squads / split into two units
    if not effects and re.search(r"(?:split|divided) into two units", d):
        effects.append({"type": "ability-grant", "target": "unit",
                        "modifier": {"ability_id": "combat-squads"}})

    # Army composition: cannot include more than one / your army cannot include
    if not effects and re.search(r"(?:army cannot include|cannot include more than one)", d):
        effects.append({"type": "attack-restriction", "target": "self",
                        "modifier": {"restriction": "unique-unit-limit"}})

    # Cannot be targeted unless within X"
    if not effects:
        m = re.search(r"cannot be targeted[^.]*unless[^.]*within (\d+)", d)
        if m:
            effects.append({"type": "attack-restriction", "target": "self",
                           "modifier": {"restriction": "targeting-range-limit", "range": int(m.group(1))}})

    # Increase enemy Stratagem cost
    if not effects and re.search(r"increase[^.]*cost[^.]*stratagem[^.]*by (\d+)", d):
        m = re.search(r"by (\d+)", d)
        effects.append({"type": "cp-gain", "target": "self",
                        "modifier": {"type": "enemy-stratagem-tax", "amount": int(m.group(1)) if m else 1}})

    # Grant Scouts to another unit
    if not effects and re.search(r"select one[^.]*unit[^.]*(?:scouts|scout)", d):
        effects.append({"type": "ability-grant", "target": "friendly-within-aura",
                        "modifier": {"ability_id": "scouts-grant"}})

    # Wargear grants Deep Strike
    if not effects and re.search(r"(?:bearer|model)[^.]*(?:has|have) the deep strike ability", d):
        effects.append({"type": "deep-strike", "target": "self", "modifier": {}})

    # Ignore vertical distance
    if not effects and re.search(r"ignore[^.]*vertical distance", d):
        effects.append({"type": "movement-modifier", "target": "unit",
                        "modifier": {"type": "ignore-vertical"}})

    # First time destroyed, roll D6, on X+ come back
    if not effects and re.search(r"(?:first time|the first time)[^.]*destroyed", d):
        if re.search(r"roll[^.]*d6[^.]*(?:set[^.]*up|return|back)", d):
            effects.append({"type": "resurrection", "target": "self",
                           "modifier": {"type": "revive-on-first-death", "trigger": "dice-roll"}})
        elif re.search(r"remove[^.]*from play[^.]*without[^.]*deadly demise", d):
            effects.append({"type": "resurrection", "target": "self",
                           "modifier": {"type": "revive-on-first-death", "suppress-deadly-demise": True}})

    # No penalty for shooting in engagement
    if not effects and re.search(r"does not suffer[^.]*penalty[^.]*hit rolls?[^.]*(?:engagement|within engagement)", d):
        effects.append({"type": "roll-modifier", "target": "self",
                        "modifier": {"roll": "hit", "operation": "ignore-engagement-penalty"}})

    # Add to Advance and Charge rolls (aura)
    if not effects and re.search(r"add (\d+) to[^.]*(?:advance and charge|charge and advance) rolls?", d):
        m = re.search(r"add (\d+)", d)
        effects.append({"type": "roll-modifier", "target": "friendly-within-aura",
                        "modifier": {"roll": "charge", "operation": "add", "value": int(m.group(1))}})

    # Re-roll Advance and Charge rolls
    if not effects and re.search(r"re-roll[^.]*(?:advance and charge|charge) rolls?", d):
        effects.append({"type": "re-roll", "target": "unit",
                        "modifier": {"roll": "charge", "condition": "any-fail"}})

    # Worsen Leadership characteristic (aura)
    if not effects and re.search(r"worsen[^.]*leadership characteristic[^.]*by (\d+)", d):
        m = re.search(r"by (\d+)", d)
        effects.append({"type": "leadership-modifier", "target": "enemy-within-aura",
                        "modifier": {"operation": "worsen", "value": int(m.group(1))}})

    # Add to Move characteristic
    if not effects:
        m = re.search(r"add (\d+)[^.]*to the move characteristic", d)
        if m:
            effects.append({"type": "stat-modifier", "target": "unit",
                           "modifier": {"stat": "M", "operation": "add", "value": int(m.group(1))}})

    # Add to Wounds characteristic
    if not effects:
        m = re.search(r"add (\d+) to[^.]*(?:bearer.s?|model.s?) wounds characteristic", d)
        if m:
            effects.append({"type": "stat-modifier", "target": "self",
                           "modifier": {"stat": "W", "operation": "add", "value": int(m.group(1))}})

    # Add to Damage characteristic on charge
    if not effects and re.search(r"(?:charge|charged)[^.]*add (\d+) to the damage characteristic", d):
        m = re.search(r"add (\d+) to the damage characteristic", d)
        if m:
            effects.append({"type": "stat-modifier", "target": "unit",
                           "modifier": {"stat": "D", "operation": "add", "value": int(m.group(1))}})

    # Conditional has Lone Operative
    if not effects and re.search(r"(?:has|have) the lone operative ability", d):
        effects.append({"type": "ability-grant", "target": "self",
                        "modifier": {"ability_id": "lone-operative"}})

    # Chapter/faction metadata (successor, keyword assignment)
    if not effects and re.search(r"(?:from the \w+ chapter|successor|gain the \w+ keyword|faction keyword)", d):
        effects.append({"type": "ability-grant", "target": "self",
                        "modifier": {"ability_id": "faction-metadata"}})

    # Must attach a specific model type
    if not effects and re.search(r"(?:you must attach|must be attached to|can join)", d):
        effects.append({"type": "ability-grant", "target": "unit",
                        "modifier": {"ability_id": "forced-attachment"}})

    # Select keyword at start of battle (Slayer's Oath pattern)
    if not effects and re.search(r"(?:start of the battle|select one)[^.]*keyword", d):
        effects.append({"type": "re-roll", "target": "unit",
                        "modifier": {"roll": "hit", "condition": "any-fail", "context": "vs-selected-keyword"}})

    # Re-roll a single Hit/Wound roll of 1 for a model (not unit-wide)
    if not effects and re.search(r"re-roll a (?:hit|wound) roll of 1", d):
        roll = "hit" if "hit roll" in d else "wound"
        effects.append({"type": "re-roll", "target": "self",
                        "modifier": {"roll": roll, "condition": "natural-1"}})

    # Re-roll Hit roll vs CHARACTER/specific keyword
    if not effects and re.search(r"re-roll the (?:hit|wound) roll[^.]*(?:character|vehicle|monster|psyker)", d):
        roll = "hit" if "hit roll" in d else "wound"
        effects.append({"type": "re-roll", "target": "self",
                        "modifier": {"roll": roll, "condition": "any-fail", "context": "vs-keyword"}})

    # Reactive shooting/fighting after enemy action
    if not effects and re.search(r"(?:opponent.s? shooting phase|enemy[^.]*targets? this model)[^.]*(?:can (?:shoot|fight)|this model can (?:shoot|fight))", d):
        effects.append({"type": "ability-grant", "target": "self",
                        "modifier": {"ability_id": "reactive-shoot-or-fight"}})

    # Increase aura range
    if not effects and re.search(r"increase the range[^.]*ability[^.]*by (\d+)", d):
        m = re.search(r"by (\d+)", d)
        effects.append({"type": "stat-modifier", "target": "self",
                        "modifier": {"stat": "aura-range", "operation": "add", "value": int(m.group(1))}})

    # Embarking within transports (special embark rule)
    if not effects and re.search(r"(?:embark|disembark)[^.]*(?:transport|vehicle)", d):
        effects.append({"type": "ability-grant", "target": "self",
                        "modifier": {"ability_id": "special-embark-rule"}})

    # Shoot/move after enemy sets up or moves (reactive)
    if not effects and re.search(r"(?:end of|at the end)[^.]*(?:opponent|enemy)[^.]*(?:movement phase|charge phase)[^.]*(?:can (?:shoot|select))", d):
        effects.append({"type": "ability-grant", "target": "self",
                        "modifier": {"ability_id": "reactive-overwatch"}})

    # --- BATCH 4: Damage-relevant stubs (hits, wounds, saves, damage) ---

    # "unmodified Hit roll of 5+ scores a Critical Hit" (lowers crit threshold)
    if not effects:
        m = re.search(r"unmodified (?:hit roll|hit rolls?) of (\d)\+[^.]*(?:critical hit|scores? a critical)", d)
        if m:
            effects.append({"type": "roll-modifier", "target": "unit",
                           "modifier": {"roll": "hit", "operation": "crit-on", "value": int(m.group(1))}})

    # "successful Hit roll scores a Critical Hit" (any successful = crit)
    if not effects and re.search(r"(?:successful|every successful) (?:hit roll|hit rolls?) scores? a critical hit", d):
        effects.append({"type": "roll-modifier", "target": "unit",
                        "modifier": {"roll": "hit", "operation": "crit-on", "value": 1}})

    # "successful unmodified Hit roll of 5+ scores a Critical Hit" (e.g., Destroyer Cult, Poxbringer)
    if not effects:
        m = re.search(r"successful unmodif\w+ hit roll of (\d)\+[^.]*critical hit", d)
        if m:
            effects.append({"type": "roll-modifier", "target": "unit",
                           "modifier": {"roll": "hit", "operation": "crit-on", "value": int(m.group(1))}})

    # Conditional reroll upgrade: "re-roll X of 1. If [condition], re-roll X instead"
    if not effects:
        # Pattern: re-roll [hit/wound] roll of 1... re-roll the [hit/wound] roll instead
        m = re.search(r"re-roll a (hit|wound) roll of 1", d)
        if m:
            roll_type = m.group(1)
            # Check if there's an upgrade condition
            if re.search(r"(?:you can )?re-roll the " + roll_type + r" roll instead", d):
                # Conditional upgrade: for hill-climbing, take the better version
                effects.append({"type": "re-roll", "target": "unit",
                               "modifier": {"roll": roll_type, "condition": "any-fail"}})
            else:
                effects.append({"type": "re-roll", "target": "unit",
                               "modifier": {"roll": roll_type, "condition": "natural-1"}})

    # "re-roll the Hit roll AND re-roll the Wound roll" (vs CHARACTER, etc.)
    if not effects and re.search(r"re-roll the hit roll[^.]*re-roll the wound roll", d):
        effects.append({"type": "re-roll", "target": "self", "modifier": {"roll": "hit", "condition": "any-fail"}})
        effects.append({"type": "re-roll", "target": "self", "modifier": {"roll": "wound", "condition": "any-fail"}})

    # "re-roll the Wound roll" (standalone, vs specific target)
    if not effects and re.search(r"(?:you can )?re-roll the wound roll", d):
        effects.append({"type": "re-roll", "target": "self",
                        "modifier": {"roll": "wound", "condition": "any-fail"}})

    # "re-roll the Hit roll" (standalone, vs specific target — e.g., at Starting Strength)
    if not effects and re.search(r"(?:you can )?re-roll the hit roll", d):
        effects.append({"type": "re-roll", "target": "self",
                        "modifier": {"roll": "hit", "condition": "any-fail"}})

    # "re-roll one Hit roll or re-roll one Wound roll" (single use per activation)
    if not effects and re.search(r"re-roll one (?:hit|wound) roll[^.]*re-roll one (?:hit|wound) roll", d):
        # This is a single reroll per activation, not per attack — weaker
        # For hill-climbing, still model it as a reroll (slight overestimate)
        effects.append({"type": "re-roll", "target": "self",
                        "modifier": {"roll": "hit", "condition": "any-fail", "uses": 1}})

    # "re-roll one Hit roll and/or one Wound roll" (Crystal Matrix pattern)
    if not effects and re.search(r"re-roll one hit roll[^.]*re-roll one wound roll", d):
        effects.append({"type": "re-roll", "target": "self",
                        "modifier": {"roll": "hit", "condition": "any-fail", "uses": 1}})

    # "worsen the Armour Penetration characteristic by 1" (defensive — enemy AP reduction)
    if not effects and re.search(r"worsen[^.]*armour penetration[^.]*by (\d+)", d):
        m = re.search(r"by (\d+)", d)
        effects.append({"type": "stat-modifier", "target": "attacker",
                        "modifier": {"stat": "AP", "operation": "worsen", "value": int(m.group(1))}})

    # "improve the Strength characteristic of that attack by 1" (on charge, etc.)
    if not effects:
        m = re.search(r"improve the strength characteristic[^.]*by (\d+)", d)
        if m:
            effects.append({"type": "stat-modifier", "target": "unit",
                           "modifier": {"stat": "S", "operation": "add", "value": int(m.group(1))}})

    # "add 1 to the Damage characteristic" (conditional — vs MONSTER/VEHICLE, on charge)
    if not effects:
        m = re.search(r"add (\d+) to the damage characteristic", d)
        if m:
            effects.append({"type": "stat-modifier", "target": "unit",
                           "modifier": {"stat": "D", "operation": "add", "value": int(m.group(1))}})

    # "add 1 to the Strength and Damage characteristics" (combined)
    if not effects:
        m = re.search(r"add (\d+) to the strength and damage characteristic", d)
        if m:
            val = int(m.group(1))
            effects.append({"type": "stat-modifier", "target": "unit", "modifier": {"stat": "S", "operation": "add", "value": val}})
            effects.append({"type": "stat-modifier", "target": "unit", "modifier": {"stat": "D", "operation": "add", "value": val}})

    # "Damage characteristic of 1 is allocated... add 1 to saving throw" (Unyielding)
    if not effects and re.search(r"damage characteristic of 1[^.]*(?:add|improve)[^.]*sav", d):
        effects.append({"type": "stat-modifier", "target": "unit",
                        "modifier": {"stat": "Sv", "operation": "improve-vs-D1", "value": 1}})

    # "on a Critical Wound, that attack has AP of -X" (Crack Shot pattern)
    if not effects:
        m = re.search(r"critical wound[^.]*armour penetration[^.]*of -(\d+)", d)
        if m:
            effects.append({"type": "stat-modifier", "target": "unit",
                           "modifier": {"stat": "AP", "operation": "set-on-crit-wound", "value": -int(m.group(1))}})

    # "mortal wounds on a 4+" for Deadly Demise (Unstable Payload)
    if not effects and re.search(r"deadly demise[^.]*(?:4\+|3\+|2\+)[^.]*instead of[^.]*6", d):
        m = re.search(r"(\d)\+[^.]*instead", d)
        if m:
            effects.append({"type": "mortal-wounds", "target": "enemy-within-aura",
                           "modifier": {"trigger": "deadly-demise", "threshold": int(m.group(1))}})

    # "cannot re-roll invulnerable saving throws" + first failed = lose invuln (Shadowfield)
    if not effects and re.search(r"cannot re-roll invulnerable[^.]*first time[^.]*failed", d):
        effects.append({"type": "invulnerable-save", "target": "self",
                        "modifier": {"type": "shadowfield", "fragile": True}})

    # "add X to Strength and Damage characteristics for every N models" (Waaagh! Energy)
    if not effects and re.search(r"add \d+ to the[^.]*(?:strength|damage)[^.]*for every \d+ models", d):
        effects.append({"type": "stat-modifier", "target": "self",
                        "modifier": {"stat": "S+D", "operation": "add-per-models", "scaling": True}})

    # "re-roll a Hit roll of 1 and re-roll a Wound roll of 1" (combined)
    if not effects and re.search(r"re-roll a hit roll of 1[^.]*re-roll a wound roll of 1", d):
        effects.append({"type": "re-roll", "target": "unit", "modifier": {"roll": "hit", "condition": "natural-1"}})
        effects.append({"type": "re-roll", "target": "unit", "modifier": {"roll": "wound", "condition": "natural-1"}})

    # "change the result of one Hit roll, one Wound roll or one Damage roll" (Branching Fates / Altered Reality)
    if not effects and re.search(r"change the result of one (?:hit|wound|damage) roll", d):
        effects.append({"type": "roll-modifier", "target": "self",
                        "modifier": {"roll": "any", "operation": "set", "value": 6, "uses": 1}})

    # Shadowfield: fragile invuln (defensive, but still generate proper DSL)
    if not effects and re.search(r"cannot re-roll invulnerable", d):
        effects.append({"type": "invulnerable-save", "target": "self",
                        "modifier": {"type": "shadowfield", "fragile": True}})

    # Designer's Note / flavor text with no mechanical effect
    if not effects and re.search(r"designer.s note", d):
        effects.append({"type": "ability-grant", "target": "self",
                        "modifier": {"ability_id": "flavor-text"}})

    # Catch-all: any remaining "while this model is leading" pattern
    if not effects and re.search(r"while this model is leading a unit", d):
        if re.search(r"models in that unit have", d):
            effects.append({"type": "ability-grant", "target": "unit",
                           "modifier": {"ability_id": "leader-grants-ability"}})

    if not effects:
        return None

    # Wrap in conditions if applicable
    conditions = extract_conditions(desc)
    scope = extract_scope(desc)

    if len(effects) == 1:
        effect = effects[0]
    else:
        effect = {"type": "sequence", "steps": effects}
        confidence = "partial"

    if conditions:
        if len(conditions) == 1:
            effect = {"type": "conditional", "condition": conditions[0], "effect": effect}
        else:
            effect = {
                "type": "conditional",
                "condition": {"operator": "and", "operands": conditions},
                "effect": effect,
            }

    behavior = "passive"
    if "once per battle" in d:
        behavior = "activated"
    elif "selected to shoot" in d or "selected to fight" in d:
        behavior = "activated"
    elif "targets this unit" in d or "would lose a wound" in d:
        behavior = "reactive"

    return effect, scope, behavior, confidence


# ---------------------------------------------------------------------------
# TIER 3: Faction rules (manual-quality parsers)
# ---------------------------------------------------------------------------

FACTION_RULE_OVERRIDES = {
    "oath-of-moment": lambda: (
        {
            "type": "sequence",
            "steps": [
                {"type": "re-roll", "target": "unit", "modifier": {"roll": "hit", "condition": "any-fail"}},
                {"type": "re-roll", "target": "unit", "modifier": {"roll": "wound", "condition": "any-fail"}},
            ],
        },
        {"range": "any-on-battlefield", "duration": "until-next-command-phase"},
        "activated", "high",
    ),
    "dark-pacts": lambda: (
        {
            "type": "choice",
            "choice_label": "Dark Pact ability",
            "options": [
                {"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Lethal Hits"]}},
                {"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Sustained Hits 1"]}},
            ],
        },
        {"range": "unit", "duration": "phase"},
        "activated", "high",
    ),
    "waaagh": lambda: (
        {
            "type": "sequence",
            "steps": [
                {"type": "stat-modifier", "target": "unit", "modifier": {"stat": "S", "operation": "add", "value": 1}},
                {"type": "stat-modifier", "target": "unit", "modifier": {"stat": "A", "operation": "add", "value": 1}},
            ],
        },
        {"range": "any-on-battlefield", "duration": "until-next-command-phase"},
        "activated", "high",
    ),
    "martial-ka-tah": lambda: (
        {
            "type": "choice",
            "choice_label": "Ka'tah Stance",
            "options": [
                {"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Sustained Hits 1"]}},
                {"type": "keyword-grant", "target": "unit", "modifier": {"keywords": ["Lethal Hits"]}},
            ],
        },
        {"range": "unit", "duration": "phase"},
        "activated", "high",
    ),
    "nurgles-gift-aura": lambda: (
        {"type": "stat-modifier", "target": "enemy-within-aura", "modifier": {"stat": "T", "operation": "subtract", "value": 1}},
        {"range": "aura-6", "duration": "permanent"},
        "aura", "high",
    ),
}


# ---------------------------------------------------------------------------
# Main converter
# ---------------------------------------------------------------------------

def load_json(path):
    with open(path) as f:
        return json.load(f)


def main():
    # Load army-assist data
    datasheets = load_json(ARMY_ASSIST / "Datasheets.json")
    abilities = load_json(ARMY_ASSIST / "Datasheets_abilities.json")
    global_abilities = load_json(ARMY_ASSIST / "Abilities.json")
    det_abilities = load_json(ARMY_ASSIST / "Detachment_abilities.json")
    strats = load_json(ARMY_ASSIST / "Stratagems.json")
    enhancements = load_json(ARMY_ASSIST / "Enhancements.json")

    # Load 40kdc unit data for faction/unit mapping
    data_dir = REPO / "data" / "core"
    factions = sorted(d.name for d in data_dir.iterdir() if d.is_dir() and not d.name.startswith("_"))

    # Map datasheet names → 40kdc unit IDs
    ds_name_map = {ds["id"]: ds for ds in datasheets}

    # Map army-assist name → 40kdc ID
    ds_to_40kdc = {}
    for ds in datasheets:
        ds_to_40kdc[ds["id"]] = name_to_id(ds["name"])

    # Group abilities by 40kdc faction
    # First, map each 40kdc unit to its army-assist datasheet abilities
    faction_abilities = defaultdict(list)  # faction → [parsed abilities]
    report_unconverted = defaultdict(list)  # faction → [(name, unit, desc)]
    stats = {"total": 0, "high": 0, "partial": 0, "stub": 0, "skipped_defensive": 0, "skipped_no_desc": 0}

    for faction in factions:
        if faction in PRESERVE_FACTIONS:
            continue

        units_path = data_dir / faction / "units.json"
        if not units_path.exists():
            continue
        units = load_json(units_path)
        aa_code = FACTION_MAP.get(faction, "")

        # Track which ability IDs we've already generated (dedup)
        seen_ids = set()

        for unit in units:
            uid = unit["id"]
            # Find matching datasheet abilities
            dsid = None
            for ds in datasheets:
                if name_to_id(ds["name"]) == uid:
                    dsid = ds["id"]
                    break
            if not dsid:
                continue

            unit_abs = [a for a in abilities if a["datasheet_id"] == dsid]

            for ab in unit_abs:
                stats["total"] += 1
                ab_name = ab.get("name", "").strip()
                ab_type = ab.get("type", "")
                ab_param = ab.get("parameter", "")
                ab_desc = ab.get("description", "")
                ab_id = name_to_id(ab_name) if ab_name else f"ability-{stats['total']}"

                # Skip faction abilities (handled separately)
                if ab_type == "Faction":
                    stats["skipped_no_desc"] += 1
                    continue

                # Skip empty descriptions
                if not ab_desc and not ab_param:
                    # Try tier 1 (name-based)
                    t1 = parse_tier1(ab_name, ab_param, ab_type)
                    if t1:
                        effect, scope, behavior, atype = t1
                        if ab_id not in seen_ids:
                            entry, conf = make_ability(
                                ab_id, ab_name, effect, scope,
                                unit_ids=[uid], ability_type=atype, behavior=behavior,
                            )
                            faction_abilities[faction].append(entry)
                            seen_ids.add(ab_id)
                            stats["high"] += 1
                    else:
                        stats["skipped_no_desc"] += 1
                    continue

                # Tier 1: template match
                t1 = parse_tier1(ab_name, ab_param, ab_type)
                if t1:
                    effect, scope, behavior, atype = t1
                    if ab_id not in seen_ids:
                        entry, conf = make_ability(
                            ab_id, ab_name, effect, scope,
                            unit_ids=[uid], ability_type=atype, behavior=behavior,
                        )
                        faction_abilities[faction].append(entry)
                        seen_ids.add(ab_id)
                        stats["high"] += 1
                    continue

                # Tier 2: pattern parse
                t2 = parse_tier2(ab_name, ab_desc, ab_type)
                if t2:
                    effect, scope, behavior, confidence = t2

                    # Skip defensive abilities per user direction
                    if classify_offense_defense(ab_desc) == "defensive":
                        stats["skipped_defensive"] += 1
                        # Still generate the entry but note it
                        if ab_id not in seen_ids:
                            entry, _ = make_ability(
                                ab_id, ab_name, effect, scope,
                                unit_ids=[uid], behavior=behavior,
                                community_notes="defensive ability (skipped for damage calc)",
                            )
                            faction_abilities[faction].append(entry)
                            seen_ids.add(ab_id)
                        continue

                    if ab_id not in seen_ids:
                        notes = "auto-generated, partial" if confidence == "partial" else None
                        entry, _ = make_ability(
                            ab_id, ab_name, effect, scope,
                            unit_ids=[uid], behavior=behavior,
                            community_notes=notes,
                        )
                        faction_abilities[faction].append(entry)
                        seen_ids.add(ab_id)
                        if confidence == "high":
                            stats["high"] += 1
                        else:
                            stats["partial"] += 1
                    continue

                # Tier 4: stub
                if ab_id not in seen_ids:
                    unit_name = unit.get("name", uid)
                    report_unconverted[faction].append((ab_name, unit_name, ab_desc[:200]))
                    entry, _ = make_ability(
                        ab_id, ab_name,
                        {"type": "stat-modifier", "target": "unit", "modifier": {}},
                        {"range": "unit", "duration": "permanent"},
                        unit_ids=[uid], behavior="passive",
                        community_notes=f"auto-generated stub — needs manual authoring. Original: {ab_desc[:150]}",
                    )
                    faction_abilities[faction].append(entry)
                    seen_ids.add(ab_id)
                    stats["stub"] += 1

        # --- Tier 3: Faction rules ---
        for ga in global_abilities:
            if ga.get("faction_id") != aa_code:
                continue
            ga_name = ga.get("name", "")
            ga_id = name_to_id(ga_name)
            ga_desc = ga.get("description", "")

            if ga_id in seen_ids:
                continue

            # Check manual overrides
            override = FACTION_RULE_OVERRIDES.get(ga_id)
            if override:
                effect, scope, behavior, confidence = override()
                entry, _ = make_ability(
                    ga_id, ga_name, effect, scope,
                    faction_id=faction, ability_type="faction", behavior=behavior,
                )
                faction_abilities[faction].append(entry)
                seen_ids.add(ga_id)
                stats["high"] += 1
                continue

            # Try tier 2 pattern parse on faction rule description
            if ga_desc:
                t2 = parse_tier2(ga_name, ga_desc, "Faction")
                if t2:
                    effect, scope, behavior, confidence = t2
                    entry, _ = make_ability(
                        ga_id, ga_name, effect, scope,
                        faction_id=faction, ability_type="faction", behavior=behavior,
                        community_notes="auto-generated from faction rule" if confidence == "partial" else None,
                    )
                    faction_abilities[faction].append(entry)
                    seen_ids.add(ga_id)
                    stats["partial" if confidence == "partial" else "high"] += 1
                    continue

            # Stub for unparseable faction rules
            if ga_desc and len(ga_desc) > 50:
                report_unconverted[faction].append((ga_name, "(faction rule)", ga_desc[:200]))
                entry, _ = make_ability(
                    ga_id, ga_name,
                    {"type": "stat-modifier", "target": "unit", "modifier": {}},
                    {"range": "any-on-battlefield", "duration": "permanent"},
                    faction_id=faction, ability_type="faction", behavior="passive",
                    community_notes=f"auto-generated stub — needs manual authoring. Original: {ga_desc[:150]}",
                )
                faction_abilities[faction].append(entry)
                seen_ids.add(ga_id)
                stats["stub"] += 1

    # --- Write output files ---
    written = 0
    for faction, abs_list in faction_abilities.items():
        if not abs_list:
            continue
        out_dir = ENRICHMENT / faction
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "abilities.json"
        with open(out_path, "w") as f:
            json.dump(abs_list, f, indent=2, ensure_ascii=False)
        written += 1

    # --- Print report ---
    total = stats["total"]
    print("=" * 80)
    print("CONVERSION REPORT")
    print("=" * 80)
    print(f"Total abilities processed:       {total}")
    print(f"  Converted (high confidence):   {stats['high']:>5d}  ({stats['high']/max(total,1)*100:.1f}%)")
    print(f"  Converted (partial):           {stats['partial']:>5d}  ({stats['partial']/max(total,1)*100:.1f}%)")
    print(f"  Stubbed (needs manual work):   {stats['stub']:>5d}  ({stats['stub']/max(total,1)*100:.1f}%)")
    print(f"  Skipped (defensive):           {stats['skipped_defensive']:>5d}  ({stats['skipped_defensive']/max(total,1)*100:.1f}%)")
    print(f"  Skipped (no description):      {stats['skipped_no_desc']:>5d}  ({stats['skipped_no_desc']/max(total,1)*100:.1f}%)")
    print(f"\nWrote abilities.json for {written} factions")
    print(f"Preserved hand-authored: {', '.join(PRESERVE_FACTIONS)}")

    print(f"\n{'=' * 80}")
    print("UNCONVERTED ABILITIES (needs manual authoring)")
    print("=" * 80)
    total_unconverted = sum(len(v) for v in report_unconverted.values())
    print(f"Total unconverted: {total_unconverted}\n")

    for faction in sorted(report_unconverted.keys()):
        items = report_unconverted[faction]
        print(f"Faction: {faction} ({len(items)} abilities)")
        for ab_name, unit_name, desc in sorted(items):
            print(f"  - {ab_name} ({unit_name}): \"{desc}...\"")
        print()


if __name__ == "__main__":
    main()
