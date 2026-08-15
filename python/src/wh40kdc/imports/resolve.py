"""Resolve a ``ParsedRoster`` onto 40kdc entity ids, producing a ``Roster``.

Resolution is lenient: a name that doesn't match a 40kdc entity yields a
resolved-ref with ``id: None``, ``resolved: False``, and up to five candidate
suggestions — the roster is never dropped or rejected. Everything that didn't
resolve cleanly is summarised in the diagnostics block.

Matching reuses the dataset's own lookups (``Collection.find`` /
``find_all`` / ``by_faction``) and ``normalize_name``; there is no bespoke
fuzzy matcher. Faction is resolved first so unit/detachment/enhancement
lookups can be scoped to it.

Python mirror of ``tools/src/import/resolve.ts``.
"""

from __future__ import annotations

import re
from typing import Any

from wh40kdc.data.dataset import Dataset
from wh40kdc.data.loadout import check_unit_legality, complete_loadout, group_loadout
from wh40kdc.data.normalize import normalize_name, strip_leading_the

#: The dataset edition/dataslate stamped onto an imported roster.
ROSTER_GAME_VERSION = {"edition": "11th", "dataslate": "pre-launch-provisional"}

_MAX_CANDIDATES = 5
_SOURCE_NAME_ALIASES = {
    "exo armour grenade launcher": "Exoarmour grenade launcher",
    "kombi rokkit": "Kombi-weapon",
    "kombi shoota": "Kombi-weapon",
    "leaders bio weapons": "Leader’s cult weapons",
    "pan spectral scanner": "Panspectral Scanner",
    "squig bomb": "Bomb Squig",
}
_FACTION_NAME_ALIASES = {
    "imperial guard": "Astra Militarum",
    "league of votann": "Leagues of Votann",
}
_DETACHMENT_SOURCE_ALIASES = {
    "hearthband covenant": "Hearthguard Covenant",
    "lord of the forge": "Lords of the Forge",
    "radzone": "Rad-Zone Corps",
}


def _faction_name_candidates(raw_name: str) -> list[str]:
    candidates = [raw_name.strip()]
    if aka := re.search(r"\baka\b\s+(.+)$", raw_name, flags=re.IGNORECASE):
        candidates.insert(0, aka.group(1).strip())
    if first := re.split(r"\s+and\s+", raw_name, flags=re.IGNORECASE)[0].strip():
        if first != raw_name.strip():
            candidates.append(first)
    if alias := _FACTION_NAME_ALIASES.get(normalize_name(raw_name)):
        candidates.insert(0, alias)
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


def _normalize_detachment_source_name(raw_name: str) -> str:
    normalized = re.sub(
        r"\s*\(\s*\d*\s*(?:detachment points?|detachementpoints?|dp|pd)\s*\)",
        "",
        re.sub(r"[‐‑‒–—]", "-", raw_name.replace("\u00a0", " ").replace("\u202f", " ")),
        flags=re.IGNORECASE,
    ).strip()
    return _DETACHMENT_SOURCE_ALIASES.get(normalize_name(normalized), normalized)


def _normalized_source_punctuation(raw_name: str) -> str:
    return re.sub(
        r"\bautocanon\b",
        "autocannon",
        re.sub(r"\s*&\s*", " and ", re.sub(r"[‐‑‒–—]", "-", raw_name)),
        flags=re.IGNORECASE,
    )


def _source_name_variants(raw_name: str) -> list[str]:
    normalized = _normalized_source_punctuation(raw_name)
    alias = _SOURCE_NAME_ALIASES.get(normalize_name(normalized))
    return list(dict.fromkeys([raw_name, normalized, *([alias] if alias else [])]))


def _lookup_name_keys(raw_name: str) -> set[str]:
    keys: set[str] = set()
    for variant in _source_name_variants(raw_name):
        keys.update((normalize_name(variant), normalize_name(f"The {variant}")))
        if stripped := strip_leading_the(variant):
            keys.add(normalize_name(stripped))
    return keys


class _DiagnosticsBuilder:
    """Accumulates warnings and resolved/unresolved tallies during an import."""

    def __init__(self) -> None:
        self.resolved_units = 0
        self.unresolved_units = 0
        self.resolved_weapons = 0
        self.unresolved_weapons = 0
        self.warnings: list[dict[str, Any]] = []

    def warn(self, code: str, message: str, raw_name: str | None = None) -> None:
        self.warnings.append({"code": code, "message": message, "raw_name": raw_name})

    def build(self) -> dict[str, Any]:
        return {
            "resolved_units": self.resolved_units,
            "unresolved_units": self.unresolved_units,
            "resolved_weapons": self.resolved_weapons,
            "unresolved_weapons": self.unresolved_weapons,
            "warnings": self.warnings,
        }


def _unresolved(raw_name: str, candidates: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {
        "id": None,
        "raw_name": raw_name,
        "resolved": False,
        "candidates": candidates if candidates is not None else [],
    }


def _resolved(id: str, raw_name: str) -> dict[str, Any]:
    return {"id": id, "raw_name": raw_name, "resolved": True, "candidates": []}


def _to_candidates(records: list[Any]) -> list[dict[str, str]]:
    out = []
    for r in records[:_MAX_CANDIDATES]:
        if isinstance(r, dict):
            entry = {"id": r["id"]}
            # Mirror TS JSON semantics: an absent name drops the key entirely
            # (JSON.stringify elides undefined values).
            if r.get("name") is not None:
                entry["name"] = r["name"]
            out.append(entry)
        else:
            out.append({"id": r.id, "name": r.name})
    return out


def _find_weapon_candidates(ds: Dataset, raw_name: str) -> list[Any]:
    for variant in _source_name_variants(raw_name):
        if hits := ds.weapons.find_all(variant):
            return hits
        if (stripped := strip_leading_the(variant)) and (hits := ds.weapons.find_all(stripped)):
            return hits
        if hits := ds.weapons.find_all(f"The {variant}"):
            return hits
    return []


def _unit_wargear_ids(ds: Dataset, hit: Any) -> list[str]:
    ids = list(hit.raw.get("weapon_ids") or [])
    for option in ds.wargear_options_of(hit.raw):
        ids.extend(option.get("replaces") or [])
        ids.extend(option.get("replacement") or [])
        for choice in option.get("replacement_choice") or []:
            ids.extend(choice)
    return list(dict.fromkeys(ids))


def _scoped_weapon_id(ds: Dataset, hit: Any, raw_name: str) -> str | None:
    ids = _unit_wargear_ids(ds, hit)
    faction_id = hit.raw.get("faction_id", "")
    direct_targets = {
        normalize_name(name) for name in (raw_name, _normalized_source_punctuation(raw_name))
    }
    for wid in ids:
        weapon = ds.weapons.get_in_faction(wid, faction_id) or ds.weapons.get_any(wid)
        if weapon and any(
            normalize_name(name) in direct_targets
            for name in (weapon.name, _normalized_source_punctuation(weapon.name))
        ):
            return weapon.id
    targets = _lookup_name_keys(raw_name)
    singular_targets = {_singular(name) for name in _source_name_variants(raw_name)}
    singular_matches: list[str] = []
    for wid in ids:
        weapon = ds.weapons.get_in_faction(wid, faction_id) or ds.weapons.get_any(wid)
        if weapon is None:
            continue
        variants = _source_name_variants(weapon.name)
        if any(normalize_name(name) in targets for name in variants):
            return weapon.id
        if any(_singular(name) in singular_targets for name in variants):
            singular_matches.append(weapon.id)
    return singular_matches[0] if len(singular_matches) == 1 else None


def _resolve_wargear_item_id(ds: Dataset, hit: Any, raw_name: str) -> str | None:
    targets = _lookup_name_keys(raw_name)
    singular_targets = {_singular(name) for name in _source_name_variants(raw_name)}
    if hit is not None:
        singular_matches: list[str] = []
        for wid in _unit_wargear_ids(ds, hit):
            item = ds.wargear.get_any(wid)
            if item is None:
                continue
            variants = _source_name_variants(item["name"])
            if any(normalize_name(name) in targets for name in variants):
                return str(item["id"])
            if any(_singular(name) in singular_targets for name in variants):
                singular_matches.append(str(item["id"]))
        if len(singular_matches) == 1:
            return singular_matches[0]
    for variant in _source_name_variants(raw_name):
        if item := ds.wargear.find(variant):
            return str(item["id"])
        if (stripped := strip_leading_the(variant)) and (item := ds.wargear.find(stripped)):
            return str(item["id"])
        if item := ds.wargear.find(f"The {variant}"):
            return str(item["id"])
    return None


def _resolve_unit_ability_id(ds: Dataset, hit: Any, raw_name: str) -> str | None:
    if hit is None:
        return None
    targets = _lookup_name_keys(raw_name)
    for ability_id in hit.raw.get("ability_ids") or []:
        ability = ds.abilities.get_in_faction(
            ability_id, hit.raw.get("faction_id", "")
        ) or ds.abilities.get_any(ability_id)
        if ability and any(
            normalize_name(name) in targets for name in _source_name_variants(ability.name)
        ):
            return ability.id
    return None


def _map_battle_size(raw: str | None) -> str | None:
    """Map a source battle-size label to the 40kdc enum, if recognisable."""
    if not raw:
        return None
    key = normalize_name(raw)
    if "strike force" in key:
        return "strike-force"
    if "incursion" in key:
        return "incursion"
    return None


def _detachment_cap(battle_size: str | None) -> int | None:
    """11e detachment-point budget for a battle size; ``None`` when unknown."""
    if battle_size == "strike-force":
        return 3
    if battle_size == "incursion":
        return 2
    return None


def resolve(parsed: dict[str, Any], ds: Dataset, format: str = "listforge") -> dict[str, Any]:
    diag = _DiagnosticsBuilder()

    # --- Faction (resolved first so other lookups can scope to it). ----------
    faction_id: str | None = None
    if parsed["faction_raw_name"]:
        hit = None
        for candidate in _faction_name_candidates(parsed["faction_raw_name"]):
            hit = ds.factions.find(candidate)
            if hit is not None:
                break
        if hit:
            faction_id = hit.id
        else:
            diag.warn(
                "faction-unresolved",
                "Faction name did not match any 40kdc faction.",
                parsed["faction_raw_name"],
            )

    if faction_id is None:
        counts: dict[str, int] = {}
        for unit in parsed["units"]:
            key = normalize_name(unit["raw_name"])
            exact_factions = {
                candidate.raw.get("faction_id")
                for candidate_name in _unit_lookup_candidates(unit["raw_name"], None, ds)
                for candidate in ds.units.find_all(candidate_name)
                if normalize_name(candidate.name) == key
                or any(
                    normalize_name(alias) == key for alias in (candidate.raw.get("aliases") or [])
                )
            }
            if len(exact_factions) == 1:
                inferred = next(iter(exact_factions))
                if inferred:
                    counts[inferred] = counts.get(inferred, 0) + 1
        ranked = sorted(counts.items(), key=lambda item: item[1], reverse=True)
        if ranked and (len(ranked) == 1 or ranked[0][1] > ranked[1][1]):
            faction_id = ranked[0][0]

    # 11e lists may field several detachments under a detachment-point cap; the
    # list preserves source order. ``dp_cost`` is looked up from the resolved
    # detachment entity (no source format reports it).
    def resolve_detachment(raw_name: str) -> dict[str, Any] | None:
        lookup_name = _normalize_detachment_source_name(raw_name)
        key = normalize_name(lookup_name)
        scoped = None
        if faction_id:
            scoped = next(
                (
                    d
                    for d in ds.detachments.by_faction(faction_id)
                    if normalize_name(d.get("name") or "") == key
                ),
                None,
            )
        hit = scoped if scoped is not None else ds.detachments.find(lookup_name)
        if hit is None:
            return None
        return {"ref": _resolved(hit["id"], raw_name), "dp_cost": hit.get("detachment_points")}

    detachments: list[dict[str, Any]] = []
    for raw_name in parsed["detachment_raw_names"]:
        whole = resolve_detachment(raw_name)
        if whole is not None:
            detachments.append(whole)
            continue
        # Dual-detachment 11e lists print both names on one line joined with
        # " and " ("Hexwarp Thrallband and Sekhetar Cohort") or a comma
        # ("Exhibition of Slaughter, Skysplinter Assault"). Splitting is a
        # RESOLVE-TIME fallback, taken only when the whole name fails and every
        # part resolves — "Legends of Saga and Song" is a real single-detachment
        # name a lexical split would corrupt.
        parts = [
            _normalize_detachment_source_name(
                part.replace("and ", "", 1) if part.lower().startswith("and ") else part
            )
            for part in re.split(r"\s+(?:and|\+)\s+|\s*,\s*", raw_name, flags=re.IGNORECASE)
            if part.strip()
        ]
        if len(parts) > 1:
            split = [resolve_detachment(p) for p in parts]
            if all(d is not None for d in split):
                detachments.extend(d for d in split if d is not None)
                continue
        diag.warn(
            "detachment-unresolved",
            "Detachment name did not match any 40kdc detachment.",
            raw_name,
        )
        detachments.append(
            {
                "ref": _unresolved(raw_name, _to_candidates(ds.detachments.find_all(raw_name))),
                "dp_cost": None,
            }
        )
    detachment_ids = [d["ref"]["id"] for d in detachments if d["ref"]["id"] is not None]

    # --- Force Disposition. -----------------------------------------------------
    # roster-json carries an already-resolved id; ListForge and WTC text carry
    # the raw header name (e.g. "Priority Assets"), resolved here against the
    # dataset.
    force_disposition = parsed.get("force_disposition")
    if not force_disposition and parsed.get("force_disposition_raw_name"):
        raw_disposition_name = parsed["force_disposition_raw_name"]
        disposition_name = (
            "Reconnaissance"
            if normalize_name(raw_disposition_name) == "recon"
            else raw_disposition_name
        )
        hit = ds.force_dispositions.find(disposition_name)
        if hit is not None:
            force_disposition = hit["id"]
        else:
            diag.warn(
                "disposition-unresolved",
                "Force Disposition name did not match any 40kdc disposition.",
                raw_disposition_name,
            )

    # --- Battle size. ---------------------------------------------------------
    battle_size = _map_battle_size(parsed["battle_size_raw"])
    if parsed["battle_size_raw"] and battle_size is None:
        diag.warn(
            "battle-size-unmapped",
            "Battle size label could not be mapped.",
            parsed["battle_size_raw"],
        )
    detachment_cap = _detachment_cap(battle_size)

    # --- Detachment-point cap check (only when cap and every cost are known). -
    if (
        detachment_cap is not None
        and detachments
        and all(d["dp_cost"] is not None for d in detachments)
    ):
        spent = sum(d["dp_cost"] for d in detachments)
        if spent > detachment_cap:
            diag.warn(
                "detachment-points-exceeded",
                f"Detachments cost {spent} detachment points but the {battle_size} "
                f"budget is {detachment_cap}.",
            )

    # --- Units (and their enhancements / wargear). ----------------------------
    units = [_resolve_unit(u, faction_id, detachment_ids, ds, diag) for u in parsed["units"]]

    # Metadata-less exports can identify their detachment unambiguously through
    # enhancement ownership; its sole Force Disposition is then likewise known.
    def detachment_by_id(id_: str) -> Any | None:
        return (
            ds.detachments.get_in_faction(id_, faction_id)
            if faction_id
            else ds.detachments.get_any(id_)
        ) or ds.detachments.get_any(id_)

    if not detachments:
        inferred = {
            enhancement.get("detachment_id")
            for unit in units
            if (enhancement_id := (unit.get("enhancement") or {}).get("id"))
            and (enhancement := ds.enhancements.get_any(enhancement_id)) is not None
            and enhancement.get("detachment_id")
        }
        if len(inferred) == 1:
            detachment_id = next(iter(inferred))
            detachment = detachment_by_id(detachment_id)
            if detachment is not None:
                detachments.append(
                    {
                        "ref": _resolved(detachment["id"], detachment["name"]),
                        "dp_cost": detachment.get("detachment_points"),
                    }
                )
                detachment_ids.append(detachment["id"])
    if (
        force_disposition is None
        and "force_disposition_raw_name" in parsed
        and parsed["force_disposition_raw_name"] is None
        and detachment_ids
    ):
        disposition_ids = {
            disposition
            for id_ in detachment_ids
            for disposition in (detachment_by_id(id_) or {}).get("force_dispositions", [])
        }
        if len(disposition_ids) == 1 and all(
            len((detachment_by_id(id_) or {}).get("force_dispositions", [])) == 1
            for id_ in detachment_ids
        ):
            force_disposition = next(iter(disposition_ids))

    if format == "gw" and not any(unit["is_warlord"] for unit in units):
        first_character = next(
            (index for index, unit in enumerate(parsed["units"]) if unit.get("is_character")),
            None,
        )
        if first_character is not None:
            units[first_character]["is_warlord"] = True

    # --- Leader attachments (second pass: needs all resolved unit ids). -------
    _apply_leader_attachments(parsed["units"], units, ds, faction_id, diag)

    # --- Points reconciliation (reported vs computed kept distinct). ----------
    if (
        parsed["total_reported"] is not None
        and parsed["total_reported"] != parsed["total_computed"]
    ):
        diag.warn(
            "points-mismatch",
            f"Source-reported total ({parsed['total_reported']}) differs from the sum "
            f"of cost lines ({parsed['total_computed']}).",
        )

    return {
        "name": parsed["name"],
        "source": {"format": format, "generated_by": parsed["generated_by"]},
        "faction_id": faction_id,
        "detachments": detachments,
        "battle_size": battle_size,
        "force_disposition": force_disposition,
        "points": {
            "declared_limit": parsed["declared_limit"],
            "detachment_cap": detachment_cap,
            "total_reported": parsed["total_reported"],
            "total_computed": parsed["total_computed"],
        },
        "units": units,
        "game_version": dict(ROSTER_GAME_VERSION),
        "diagnostics": diag.build(),
    }


#: The canonical prefix the dataset uses for shared Chaos chassis ("Chaos
#: Rhino", "Chaos Land Raider", …). GW/NewRecruit subfaction exports substitute
#: the faction name for it ("Death Guard Rhino"), so swapping it back is one of
#: the candidate lookups (see :func:`_unit_lookup_candidates`).
_CHAOS_CHASSIS_PREFIX = "Chaos "


def _unit_lookup_candidates(raw_name: str, faction_id: str | None, ds: Dataset) -> list[str]:
    """Candidate lookup strings for a unit name, in priority order.

    GW/NewRecruit exports prefix shared chassis with the faction's display name
    in two forms: keeping "Chaos" ("Death Guard Chaos Spawn" → dataset "Chaos
    Spawn") or replacing it ("Death Guard Rhino" → dataset "Chaos Rhino"). When
    ``raw_name`` starts with the resolved faction's display name we therefore
    also try the prefix stripped, and the prefix replaced with
    :data:`_CHAOS_CHASSIS_PREFIX`. The original ``raw_name`` is always what gets
    recorded on the ref — only the lookup is adjusted. This is a general rule
    over all shared Chaos chassis × every faction, not per-unit data.
    """
    candidates = [raw_name]
    delimited = re.split(r"\s+--?\s+", raw_name)[-1].strip()
    if delimited and delimited != raw_name:
        candidates.append(delimited)
    without_nickname = re.sub(r'\s+(?:["“][^"”]+["”]|\'[^\']+\')\s*$', "", raw_name)
    if without_nickname != raw_name:
        candidates.append(without_nickname)
    faction = ds.factions.get(faction_id) if faction_id else None
    faction_name = faction.name if faction is not None else None
    if faction_name:
        prefix = f"{faction_name} "
        if len(raw_name) > len(prefix) and raw_name.lower().startswith(prefix.lower()):
            rest = raw_name[len(prefix) :].lstrip()
            if rest:
                candidates.append(rest)
                candidates.append(_CHAOS_CHASSIS_PREFIX + rest)
    # De-duplicate while preserving order (e.g. a name already starting "Chaos ").
    seen: set[str] = set()
    deduped: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            deduped.append(c)
    return deduped


def _singular(s: str) -> str:
    """Singular/plural- and case-insensitive form for model-line matching:
    :func:`normalize_name` then drop every 's' at a word boundary — exact mirror
    of the TS ``normalizeName(s).replace(/s\\b/g, "")`` (a boundary is a
    following non-``\\w`` character or end of string)."""
    n = normalize_name(s)
    out = []
    for i, ch in enumerate(n):
        nxt = n[i + 1] if i + 1 < len(n) else ""
        next_is_word = nxt.isascii() and (nxt.isalnum() or nxt == "_")
        if ch == "s" and not next_is_word:
            continue
        out.append(ch)
    return "".join(out)


def _resolve_unit(
    parsed: dict[str, Any],
    faction_id: str | None,
    detachment_ids: list[str],
    ds: Dataset,
    diag: _DiagnosticsBuilder,
) -> dict[str, Any]:
    lookup_names = _unit_lookup_candidates(parsed["raw_name"], faction_id, ds)

    # Prefer a faction-scoped exact match (the same unit id recurs across
    # factions, and a stripped base name can collide with another faction's
    # unit — e.g. "Rhino" matches the Space Marine Rhino), matching canonical
    # name or alias.
    in_faction = ds.units.by_faction(faction_id) if faction_id else []

    def _scoped_exact(query: str) -> Any | None:
        k = normalize_name(query)
        for u in in_faction:
            if normalize_name(u.name) == k:
                return u
            if any(normalize_name(a) == k for a in (u.raw.get("aliases") or [])):
                return u
        return None

    hit = None
    for q in lookup_names:
        hit = _scoped_exact(q)
        if hit is not None:
            break

    all_hits: list[Any] = []
    if hit is None:
        # Global fallback (alias-aware via the name index); still prefer the
        # resolved faction's copy of a shared id over whichever copy registered
        # first.
        for q in lookup_names:
            all_hits = ds.units.find_all(q)
            if faction_id:
                hit = next((u for u in all_hits if u.raw.get("faction_id") == faction_id), None)
            if hit is None and all_hits:
                hit = all_hits[0]
            if hit is not None:
                break

    if hit is not None:
        ref = _resolved(hit.id, parsed["raw_name"])
        diag.resolved_units += 1
    else:
        ref = _unresolved(parsed["raw_name"], _to_candidates(all_hits))
        diag.unresolved_units += 1
        diag.warn("unit-unresolved", "Unit name did not match any 40kdc unit.", parsed["raw_name"])

    enhancement = (
        _resolve_enhancement(parsed["enhancement_raw_name"], detachment_ids, ds, diag)
        if parsed["enhancement_raw_name"]
        else None
    )
    enhancement_points = None if enhancement is None else parsed["enhancement_points"]

    # ── Model-line reclassification ─────────────────────────────────────────
    # The flat GW dialects print model bullets at the same indent as weapon
    # bullets, so the parser cannot tell "• 9x Pathfinder" from "• 10x Pulse
    # carbine" — the model names land in ``wargear`` and ``model_count``
    # collapses to its 1 fallback. The RESOLVED unit knows its composition row
    # names — and its own name covers vehicle squadrons ("2x Hippogriff AFV") —
    # so a wargear entry matching one (singular/plural-insensitive) is a model
    # line: its count rebuilds the model count and it leaves the wargear bag.
    # Mirror of the TS reference.
    model_count = parsed["model_count"]
    wargear_lines = parsed["wargear"]
    if hit is not None:
        composition = ds.unit_composition_of(hit.raw) or {}
        rows = composition.get("models") or []
        unit_model_names = {
            _singular(hit.name),
            *(_singular(alias) for alias in hit.raw.get("aliases") or []),
        }
        composition_model_names = {
            _singular(name)
            for row in rows
            for name in (row.get("name"), row.get("profile_name"))
            if name
        }

        def model_line_keys(raw_name: str) -> set[str]:
            variants = [raw_name, *re.split(r"\s+--?\s+", raw_name)]
            if with_base := re.split(r"\s+with\s+", raw_name, flags=re.IGNORECASE)[0].strip():
                variants.append(with_base)
            without_role = re.sub(r"\s+character$", "", raw_name, flags=re.IGNORECASE)
            if without_role != raw_name:
                variants.append(without_role)
            without_nickname = re.sub(r'\s+(?:["“][^"”]+["”]?|\'[^\']+\'?)\s*$', "", raw_name)
            if without_nickname != raw_name:
                variants.append(without_nickname)
            return {
                _singular(variant) for name in variants for variant in _source_name_variants(name)
            }

        def matches_model_name(raw_name: str, model_name: str) -> bool:
            return any(
                key == model_name or (" with " not in model_name and model_name.endswith(f" {key}"))
                for key in model_line_keys(raw_name)
            )

        def is_model_line(raw_name: str) -> bool:
            keys = model_line_keys(raw_name)
            if keys & (unit_model_names | composition_model_names):
                return True
            return sum(matches_model_name(raw_name, name) for name in composition_model_names) == 1

        model_lines = [item for item in parsed["wargear"] if is_model_line(item["raw_name"])]
        model_sum = sum(item["count"] for item in model_lines)
        if model_sum > 0:
            wargear_lines = [
                item for item in parsed["wargear"] if not is_model_line(item["raw_name"])
            ]
            parsed_count_valid = any(
                sum(model.get("min") or 0 for model in tier.get("models") or [])
                <= parsed["model_count"]
                <= sum(model.get("max") or 0 for model in tier.get("models") or [])
                for tier in composition.get("tiers") or []
            ) or (
                not composition.get("tiers")
                and rows
                and sum(model.get("min") or 0 for model in rows)
                <= parsed["model_count"]
                <= sum(model.get("max") or 0 for model in rows)
            )
            model_sum_matches_points = parsed["points"] is not None and any(
                tier.get("cost") == parsed["points"]
                and tier.get("models", 0)
                <= model_sum
                <= (
                    tier["models_max"]
                    if tier.get("models_max") is not None
                    else tier.get("models", 0)
                )
                for tier in hit.raw.get("points") or []
            )
            covered = not rows or all(
                (row.get("min") or 0) <= 0
                or (not row.get("name") and not row.get("profile_name"))
                or any(
                    (
                        row.get("name")
                        and matches_model_name(line["raw_name"], _singular(row["name"]))
                    )
                    or (
                        row.get("profile_name")
                        and matches_model_name(line["raw_name"], _singular(row["profile_name"]))
                    )
                    for line in model_lines
                )
                for row in rows
            )
            model_count = (
                model_sum
                if model_sum_matches_points or covered
                else parsed["model_count"]
                if parsed_count_valid
                else parsed["model_count"] + model_sum
            )

    def resolve_gear_ref(raw_name: str) -> dict[str, Any] | None:
        if hit is not None and (scoped_id := _scoped_weapon_id(ds, hit, raw_name)):
            return _resolved(scoped_id, raw_name)
        if hits := _find_weapon_candidates(ds, raw_name):
            return _resolved(hits[0].id, raw_name)
        if item_id := _resolve_wargear_item_id(ds, hit, raw_name):
            return _resolved(item_id, raw_name)
        if ability_id := _resolve_unit_ability_id(ds, hit, raw_name):
            return _resolved(ability_id, raw_name)
        return None

    wargear: list[dict[str, Any]] = []
    for line in wargear_lines:
        direct = resolve_gear_ref(line["raw_name"])
        if direct is not None:
            diag.resolved_weapons += 1
            wargear.append({"ref": direct, "count": line["count"]})
            continue
        parts = [
            part.strip() for part in re.split(r"\s+and\s+", line["raw_name"], flags=re.IGNORECASE)
        ]
        part_refs = [resolve_gear_ref(part) for part in parts]
        if len(parts) > 1 and all(part_refs):
            diag.resolved_weapons += len(part_refs)
            wargear.extend(
                {"ref": part_ref, "count": line["count"] if index == 0 else 1}
                for index, part_ref in enumerate(part_refs)
            )
            continue
        diag.unresolved_weapons += 1
        diag.warn(
            "weapon-unresolved", "Weapon name did not match any 40kdc weapon.", line["raw_name"]
        )
        wargear.append(
            {
                "ref": _unresolved(
                    line["raw_name"], _to_candidates(_find_weapon_candidates(ds, line["raw_name"]))
                ),
                "count": line["count"],
            }
        )

    loadout_groups: list[dict[str, Any]] | None
    explicit_groups = parsed.get("loadout_groups")
    if explicit_groups is not None:

        def explicit_group_refs(raw_name: str, count: int) -> list[dict[str, Any]]:
            direct = next(
                (
                    item["ref"]
                    for item in wargear
                    if normalize_name(item["ref"]["raw_name"]) == normalize_name(raw_name)
                ),
                None,
            )
            if direct is not None:
                return [{"ref": direct, "count": count}]
            if ref := resolve_gear_ref(raw_name):
                return [{"ref": ref, "count": count}]
            parts = [part.strip() for part in re.split(r"\s+and\s+", raw_name, flags=re.IGNORECASE)]
            refs = [resolve_gear_ref(part) for part in parts]
            if len(parts) > 1 and all(refs):
                return [{"ref": ref, "count": count} for ref in refs]
            return [{"ref": _unresolved(raw_name), "count": count}]

        loadout_groups = [
            {
                "model_name": group["model_name"],
                "count": group["count"],
                "wargear": [
                    resolved_item
                    for item in group["wargear"]
                    for resolved_item in explicit_group_refs(item["raw_name"], item["count"])
                ],
            }
            for group in explicit_groups
        ]
        if all(
            item["ref"]["id"] is not None for group in loadout_groups for item in group["wargear"]
        ):
            original_ids = {item["ref"]["id"] for item in wargear}
            grouped: dict[str, dict[str, Any]] = {}
            for group in loadout_groups:
                for item in group["wargear"]:
                    id_ = item["ref"]["id"]
                    if id_ not in grouped:
                        grouped[id_] = {"ref": item["ref"], "count": 0}
                    grouped[id_]["count"] += group["count"] * item["count"]
            remaining = dict(grouped)
            seen: set[str] = set()
            ordered: list[dict[str, Any]] = []
            for item in wargear:
                id_ = item["ref"]["id"]
                if id_ in seen:
                    continue
                seen.add(id_)
                ordered.append(remaining.pop(id_, item))
            diag.resolved_weapons += sum(id_ not in original_ids for id_ in remaining)
            wargear = [*ordered, *remaining.values()]
    else:
        loadout_groups = _build_loadout_groups(hit, model_count, wargear, ds)
        if (
            loadout_groups is None
            and hit is not None
            and all(item["ref"]["id"] is not None for item in wargear)
        ):
            explicit_refs = {item["ref"]["id"]: item["ref"] for item in wargear}
            explicit_counts: dict[str, int] = {}
            for item in wargear:
                id_ = item["ref"]["id"]
                explicit_counts[id_] = explicit_counts.get(id_, 0) + item["count"]
            completed = complete_loadout(
                hit.raw,
                model_count,
                ds.wargear_options_of(hit.raw),
                (ds.unit_composition_of(hit.raw) or {}).get("models"),
                explicit_counts,
            )
            if completed is not None:

                def ref_for_id(id_: str) -> dict[str, Any]:
                    if existing := explicit_refs.get(id_):
                        return existing
                    entity = (
                        next((weapon for weapon in hit.weapons if weapon.id == id_), None)
                        or ds.wargear.get_any(id_)
                        or ds.abilities.get_any(id_)
                    )
                    if entity is None:
                        name = id_
                    elif isinstance(entity, dict):
                        name = entity.get("name", id_)
                    else:
                        name = entity.name
                    return _resolved(id_, name)

                remaining = {
                    id_: {"ref": ref_for_id(id_), "count": count}
                    for id_, count in completed["counts"].items()
                }
                completed_seen: set[str] = set()
                ordered = []
                for item in wargear:
                    id_ = item["ref"]["id"]
                    if id_ in completed_seen:
                        continue
                    completed_seen.add(id_)
                    if replacement := remaining.pop(id_, None):
                        ordered.append({**item, "count": replacement["count"]})
                diag.resolved_weapons += sum(id_ not in explicit_refs for id_ in remaining)
                wargear = [*ordered, *remaining.values()]
                loadout_groups = (
                    [
                        {
                            "model_name": group["model_name"],
                            "count": group["count"],
                            "wargear": [
                                {"ref": ref_for_id(item["id"]), "count": item["count"]}
                                for item in group["weapons"]
                            ],
                        }
                        for group in completed["groups"]
                    ]
                    if completed["groups"] is not None
                    else None
                )

    keyword_overrides = list(dict.fromkeys(parsed.get("keyword_overrides") or []))
    if (
        parsed.get("is_character")
        and hit is not None
        and not (
            hit.raw.get("role") in ("character", "epic-hero")
            or "Character" in (hit.raw.get("keywords") or [])
        )
        and "Character" not in keyword_overrides
    ):
        keyword_overrides.append("Character")

    result: dict[str, Any] = {
        "ref": ref,
        "model_count": model_count,
        "points": parsed["points"],
        "is_warlord": parsed["is_warlord"],
        "enhancement": enhancement,
        **({"keyword_overrides": list(keyword_overrides)} if keyword_overrides else {}),
        "enhancement_points": enhancement_points,
        "wargear": wargear,
    }
    if loadout_groups is not None:
        result["loadout_groups"] = loadout_groups
    result["leader_attachment"] = None

    # Loadout legality — the conservative checker over the fully-resolved counts.
    # Gated exactly like grouping (an unresolved unit has no datasheet; an
    # unresolved weapon means the counts under-report the list), plus two
    # import-specific reliability gates: the parsed model count must sit inside
    # the composition envelope (the GW flat dialect infers ``model_count: 1`` for
    # some units, so ``invalid-model-count`` is also filtered), and ``below-min``
    # is filtered (list formats omit implicit default weapons). Mirror of the TS
    # reference.
    if hit is not None and all(w["ref"]["id"] is not None for w in wargear):
        comp = ds.unit_composition_of(hit.raw) or {}
        rows = comp.get("models") or []
        env_min = sum((m.get("min") or 0) for m in rows)
        env_max = sum((m.get("max") or 0) for m in rows)
        if not rows or env_min <= model_count <= env_max:
            counts: dict[str, int] = {}
            for w in wargear:
                wid = w["ref"]["id"]
                counts[wid] = counts.get(wid, 0) + w["count"]
            violations = [
                v
                for v in check_unit_legality(
                    hit.raw,
                    model_count,
                    ds.wargear_options_of(hit.raw),
                    counts,
                    comp.get("models"),
                    comp.get("tiers"),
                )
                if v["code"] not in ("invalid-model-count", "below-min")
            ]
            if violations:
                detail = ", ".join(f"{v['code']}:{v['id']}" for v in violations)
                diag.warn(
                    "loadout-illegal",
                    "Loadout is not buildable from the datasheet's wargear options: " + detail,
                    parsed["raw_name"],
                )
    return result


def _build_loadout_groups(
    hit: Any,
    model_count: int,
    wargear: list[dict[str, Any]],
    ds: Dataset,
) -> list[dict[str, Any]] | None:
    """Recompute a unit's ``loadout_groups`` from its resolved wargear via
    :func:`group_loadout` — the same maths the exporter uses, so an import→export
    round-trip is stable. ``None`` when the unit is unresolved, any weapon is
    unresolved, or the loadout doesn't decompose exactly. Mirror of the TS
    ``buildLoadoutGroups``.
    """
    if hit is None:
        return None
    ref_by_id: dict[str, Any] = {}
    counts: dict[str, int] = {}
    for w in wargear:
        wid = w["ref"].get("id")
        if wid is None:
            return None
        ref_by_id[wid] = w["ref"]
        counts[wid] = counts.get(wid, 0) + w["count"]
    options = ds.wargear_options_of(hit.raw)
    comp = ds.unit_composition_of(hit.raw)
    models = comp.get("models") if comp else None
    groups = group_loadout(hit.raw, model_count, options, models, counts)
    if groups is None:
        return None
    return [
        {
            "model_name": g["model_name"],
            "count": g["count"],
            "wargear": [{"ref": ref_by_id[w["id"]], "count": w["count"]} for w in g["weapons"]],
        }
        for g in groups
    ]


def _resolve_enhancement(
    raw_name: str,
    detachment_ids: list[str],
    ds: Dataset,
    diag: _DiagnosticsBuilder,
) -> dict[str, Any]:
    key = normalize_name(raw_name)
    # Enhancements belong to a detachment, not a faction — scope to any of the
    # roster's resolved detachments.
    scoped = None
    if detachment_ids:
        scoped = next(
            (
                e
                for e in ds.enhancements.all
                if e.get("detachment_id") in detachment_ids
                and normalize_name(e.get("name") or "") == key
            ),
            None,
        )
    hit = scoped if scoped is not None else ds.enhancements.find(raw_name)
    if hit is not None:
        return _resolved(hit["id"], raw_name)
    diag.warn(
        "enhancement-unresolved",
        "Enhancement name did not match any 40kdc enhancement.",
        raw_name,
    )
    return _unresolved(raw_name, _to_candidates(ds.enhancements.find_all(raw_name)))


def _apply_leader_attachments(
    parsed_units: list[dict[str, Any]],
    units: list[dict[str, Any]],
    ds: Dataset,
    faction_id: str | None,
    diag: _DiagnosticsBuilder,
) -> None:
    """Resolve leader→bodyguard attachments in two passes.

    1. **Explicit** attachments carried verbatim from the source (only the
       canonical roster-json round-trip encodes one) are reconstructed exactly:
       the bodyguard id is re-resolved against the current dataset, but the role
       and provisional flag are preserved. This makes the round-trip lossless,
       including ``leader``-role attachments inference never produces.
    2. For every other character the source does not encode an unambiguous
       attachment, so each **inferred** link is marked provisional: a resolved
       ``support`` character (which cannot operate alone) is matched against a
       resolved bodyguard present in the roster via the leader-attachment data.
    """
    # --- Pass 1: explicit attachments (lossless). ----------------------------
    for i, unit in enumerate(units):
        explicit = parsed_units[i].get("leader_attachment")
        if explicit is None:
            continue
        key = normalize_name(explicit["bodyguard_raw_name"])
        bodyguard = next((u for u in units if normalize_name(u["ref"]["raw_name"]) == key), None)
        if bodyguard is None:
            continue
        bodyguard_ref = (
            _resolved(bodyguard["ref"]["id"], bodyguard["ref"]["raw_name"])
            if bodyguard["ref"]["id"]
            else _unresolved(bodyguard["ref"]["raw_name"])
        )
        unit["leader_attachment"] = {
            "bodyguard_ref": bodyguard_ref,
            "role": explicit["role"],
            "provisional": explicit["provisional"],
        }

    # --- Pass 2: inference for characters without an explicit attachment. -----
    bodyguard_ids = {
        u["ref"]["id"]
        for i, u in enumerate(units)
        if u["ref"]["id"] and not parsed_units[i]["is_character"]
    }

    for i, unit in enumerate(units):
        if parsed_units[i].get("leader_attachment") is not None:
            continue  # explicit already applied in pass 1
        if not unit["ref"]["id"] or not parsed_units[i]["is_character"]:
            continue
        leader_id = unit["ref"]["id"]
        # Only `support` characters are auto-attached: per the GW datasheet
        # bodyguard-group data they cannot operate alone, so attaching to an
        # eligible bodyguard present in the roster is certain. A `leader` (or a
        # character with no attachment_role) MAY be solo — the source doesn't
        # encode the attachment, so we don't guess one. attachment_role is
        # faction-specific (e.g. the World Eaters Master of Executions is a
        # leader while the Chaos Space Marines one is support), so resolve
        # faction-scoped.
        resolved_unit = (
            (ds.units.get_in_faction(leader_id, faction_id) or ds.units.get(leader_id))
            if faction_id
            else ds.units.get_any(leader_id)
        )
        if resolved_unit is None or resolved_unit.raw.get("attachment_role") != "support":
            continue

        attachment = next(
            (la for la in ds.leader_attachments if la.get("leader_id") == leader_id), None
        )
        if attachment is None:
            continue
        bodyguard_id = next(
            (id_ for id_ in attachment.get("eligible_bodyguard_ids", []) if id_ in bodyguard_ids),
            None,
        )
        if bodyguard_id is None:
            continue

        bodyguard = next((u for u in units if u["ref"]["id"] == bodyguard_id), None)
        if bodyguard is None:
            continue

        unit["leader_attachment"] = {
            "bodyguard_ref": _resolved(bodyguard_id, bodyguard["ref"]["raw_name"]),
            "role": "support",
            "provisional": True,
        }
        diag.warn(
            "leader-attachment-inferred",
            "Support character attached to an eligible bodyguard (it cannot "
            "operate alone); provisional.",
            unit["ref"]["raw_name"],
        )
