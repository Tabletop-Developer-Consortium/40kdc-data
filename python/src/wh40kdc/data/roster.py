"""Whole-army roster legality: the per-unit loadout check plus the nine
army-construction dimensions layered over it (enhancements, leader attachment,
points, detachment points, force disposition, detachment tags/restrictions,
warlord, unit minimums).

A roster is legal iff its ``army`` list has no ``error``-severity entries and
every ``units[].violations`` is empty (force-disposition advisories are
``warn`` — provisional 11e data).

Python mirror of the roster-legality half of ``tools/src/data/roster-resolve.ts``
(``validateRosterCore`` / ``checkRoster``).
"""

from __future__ import annotations

from typing import Any

from wh40kdc.data.battle_sizes import (
    detachment_cap_for_battle_size,
    points_limit_for_battle_size,
)
from wh40kdc.data.dataset import Dataset
from wh40kdc.data.loadout import check_unit_legality
from wh40kdc.data.pricing import host_unit_points, wargear_points

#: Army-construction violation codes (distinct from per-unit loadout codes).
ROSTER_VIOLATION_CODES = (
    "enhancement-wrong-detachment",
    "enhancement-on-non-character",
    "enhancement-keyword-mismatch",
    "enhancement-excluded-keyword",
    "enhancement-over-max-targets",
    "leader-attachment-illegal",
    "leader-must-attach",
    "points-over-limit",
    "detachment-points-over",
    "disposition-not-picked",
    "disposition-invalid",
    "detachment-tag-conflict",
    "detachment-restriction-required",
    "detachment-restriction-excluded",
    "unit-excluded-from-faction",
    "no-warlord",
    "multiple-warlords",
    "unit-minimum-unmet",
)


def _keyword_set(
    unit: dict[str, Any],
    army_keywords: list[str],
    army_keyword_set: set[str],
    detachment_ids: list[str],
    keyword_overrides: list[str] | None = None,
) -> set[str]:
    """Return the roster-contextual keyword set used by construction checks."""
    owned = set(unit.get("keywords") or []) | set(unit.get("faction_keywords") or [])
    owned.add(unit.get("name"))
    faction_keywords = unit.get("faction_keywords") or []
    if army_keyword_set and all(keyword in army_keyword_set for keyword in faction_keywords):
        owned.update(army_keywords)
    for grant in unit.get("conditional_keywords") or []:
        required_detachment_id = grant.get("required_detachment_id")
        if required_detachment_id and required_detachment_id not in detachment_ids:
            continue
        required_faction_keyword = grant.get("required_faction_keyword")
        if required_faction_keyword and required_faction_keyword not in army_keyword_set:
            continue
        owned.add(grant["keyword"])
    owned.update(keyword_overrides or [])
    return owned


def _is_character(unit: dict[str, Any]) -> bool:
    role = unit.get("role")
    return role in ("character", "epic-hero") or "Character" in (unit.get("keywords") or [])


def validate_roster_core(spec: dict[str, Any], dataset: Dataset) -> dict[str, Any]:
    """The shared roster-legality core. Runs the per-unit loadout check on every
    resolved unit, then the nine army-construction dimensions.

    ``spec`` keys: ``faction_id`` (str | None), ``battle_size`` (str | None),
    ``force_disposition`` (str | None), ``detachment_ids`` (list[str]), and
    ``units`` — a list of dicts with ``unit_id``, ``model_count``,
    ``is_warlord`` (bool), ``enhancement_id`` (str | None),
    ``leader_bodyguard_id`` (str | None), and ``counts`` (id → int). A
    unit-scoped violation's ``unitIndex`` indexes ``spec["units"]``.

    Returns ``{"units": [UnitLegality], "army": [RosterViolation]}``.
    """
    faction_id = spec.get("faction_id")
    spec_units: list[dict[str, Any]] = spec.get("units") or []
    detachment_ids: list[str] = spec.get("detachment_ids") or []

    army: list[dict[str, Any]] = []

    def push(
        severity: str,
        code: str,
        id_: str,
        message: str,
        unit_index: int | None = None,
    ) -> None:
        army.append(
            {
                "code": code,
                "id": id_,
                "message": message,
                "unitIndex": unit_index,
                "severity": severity,
            }
        )

    def err(code: str, id_: str, message: str, unit_index: int | None = None) -> None:
        push("error", code, id_, message, unit_index)

    def resolve_unit(unit_id: str) -> Any:
        if not unit_id:
            return None
        if faction_id:
            scoped = dataset.units.get_in_faction(unit_id, faction_id)
            if scoped is not None:
                return scoped
        return dataset.units.get_any(unit_id)

    # The army faction's keywords ([Imperium, Adeptus Astartes, Blood Angels]
    # for a chapter): every unit in the faction's pool owns them — the
    # <CHAPTER>-style keyword that chapter-shared datasheet records can't
    # carry. Granted with the same subset rule that scopes a chapter's unit
    # pool, so allied units never gain them.
    army_keywords: list[str] = []
    if faction_id:
        army_faction = dataset.factions.get(faction_id)
        if army_faction is not None:
            army_keywords = list(army_faction.raw.get("keywords") or [])
    army_keyword_set = set(army_keywords)

    views = [resolve_unit(u.get("unit_id") or "") for u in spec_units]

    # --- Per-unit loadout (reuse the tier/bounds checker). --------------------
    units: list[dict[str, Any]] = []
    for idx, su in enumerate(spec_units):
        view = views[idx]
        if view is None:
            continue
        options = dataset.wargear_options_of(view.raw)
        composition = dataset.unit_composition_of(view.raw)
        units.append(
            {
                "unitId": view.id,
                "unitIndex": idx,
                "modelCount": su.get("model_count") or 0,
                "violations": check_unit_legality(
                    view.raw,
                    su.get("model_count") or 0,
                    options,
                    su.get("counts") or {},
                    (composition or {}).get("models"),
                    (composition or {}).get("tiers"),
                ),
            }
        )

    # Shared detachment ids (Codex chapters) resolve within the roster's
    # faction; fall back first-wins when the spec names no faction.
    detachments = [
        d
        for d in (
            (dataset.detachments.get_in_faction(id_, faction_id) if faction_id else None)
            or dataset.detachments.get_any(id_)
            for id_ in detachment_ids
        )
        if d is not None
    ]
    # --- Enhancements: per-unit eligibility + army-wide uniqueness. -----------
    enh_uses: dict[str, int] = {}
    for idx, su in enumerate(spec_units):
        enhancement_id = su.get("enhancement_id")
        if not enhancement_id:
            continue
        enh_uses[enhancement_id] = enh_uses.get(enhancement_id, 0) + 1
        enh = dataset.enhancements.get(enhancement_id)
        view = views[idx]
        if enh is None or view is None:
            continue
        if enh.get("detachment_id") not in detachment_ids:
            err(
                "enhancement-wrong-detachment",
                enh["id"],
                f"{enh['id']} is not from a detachment in this roster",
                idx,
            )
        overrides = su.get("keyword_overrides") or []
        if (
            not _is_character(view.raw)
            and "Character" not in overrides
            and enh.get("upgrade_tag") is not True
        ):
            err(
                "enhancement-on-non-character",
                enh["id"],
                f"{enh['id']} can only be taken by a Character",
                idx,
            )
        kws = _keyword_set(
            view.raw,
            army_keywords,
            army_keyword_set,
            detachment_ids,
            overrides,
        )
        groups = enh.get("keyword_restriction_groups")
        eligible = (
            any(all(keyword in kws for keyword in group) for group in groups)
            if groups is not None
            else all(keyword in kws for keyword in (enh.get("keyword_restrictions") or []))
        )
        if not eligible:
            err(
                "enhancement-keyword-mismatch",
                enh["id"],
                f"{view.id} lacks an eligible keyword group for {enh['id']}",
                idx,
            )
        if any(k in kws for k in (enh.get("exclusion_keywords") or [])):
            err(
                "enhancement-excluded-keyword",
                enh["id"],
                f"{view.id} carries a keyword excluded by {enh['id']}",
                idx,
            )
    for enh_id, uses in enh_uses.items():
        max_targets = (dataset.enhancements.get(enh_id) or {}).get("max_targets")
        if max_targets is None:
            max_targets = 1
        if uses > max_targets:
            err(
                "enhancement-over-max-targets",
                enh_id,
                f"{enh_id} taken {uses} times, max {max_targets}",
            )

    # --- Leader attachment. ----------------------------------------------------
    for idx, su in enumerate(spec_units):
        view = views[idx]
        if view is None:
            continue
        leader_bodyguard_id = su.get("leader_bodyguard_id")
        if leader_bodyguard_id:
            eligible_bodyguards = {v.id for v in dataset.bodyguards_attachable_from(view.id)}
            enhancement = (
                dataset.enhancements.get(su["enhancement_id"]) if su.get("enhancement_id") else None
            )
            if enhancement is not None:
                eligible_bodyguards.update(enhancement.get("attachment_bodyguard_ids") or [])
            if leader_bodyguard_id not in eligible_bodyguards:
                err(
                    "leader-attachment-illegal",
                    view.id,
                    f"{view.id} cannot attach to {leader_bodyguard_id}",
                    idx,
                )
        elif view.raw.get("attachment_role") == "support" and (
            _is_character(view.raw) or "Character" in (su.get("keyword_overrides") or [])
        ):
            err(
                "leader-must-attach",
                view.id,
                f"{view.id} is a Support character and must attach to a unit",
                idx,
            )

    # --- Points total (ordinal-aware) + enhancement costs. --------------------
    # Host-aware: a foreign unit with an ``allied_points`` entry for this army
    # (Agents' Imperium price, a chapter's reprice of a shared datasheet)
    # prices from that entry, not its native table.
    roster_faction_view = dataset.factions.get(faction_id) if faction_id else None
    roster_faction = roster_faction_view.raw if roster_faction_view else None
    ordinals: dict[str, int] = {}
    total = 0
    for idx, su in enumerate(spec_units):
        view = views[idx]
        if view is None:
            continue
        unit_id = su.get("unit_id") or ""
        ordinal = ordinals.get(unit_id, 0) + 1
        ordinals[unit_id] = ordinal
        total += host_unit_points(view.raw, su.get("model_count") or 0, ordinal, roster_faction)
        total += wargear_points(view.raw, su.get("counts") or {})
        enhancement_id = su.get("enhancement_id")
        if enhancement_id:
            total += (dataset.enhancements.get(enhancement_id) or {}).get("cost") or 0
    limit = points_limit_for_battle_size(spec.get("battle_size"))
    if limit is not None and total > limit:
        err("points-over-limit", "roster", f"army totals {total}, over the {limit} limit")

    # --- Detachment-point budget. ---------------------------------------------
    cap = detachment_cap_for_battle_size(spec.get("battle_size"))
    dp_used = sum((d.get("detachment_points") or 0) for d in detachments)
    if cap is not None and dp_used > cap:
        err(
            "detachment-points-over",
            "roster",
            f"detachments cost {dp_used} DP, over the {cap} budget",
        )

    # --- Force disposition (advisory / warn). ---------------------------------
    # Any selected detachment may grant the pick; detachments whose data does
    # not record force_dispositions are skipped, and when none record them the
    # check is inconclusive and stays silent.
    force_disposition = spec.get("force_disposition")
    if force_disposition is None:
        push("warn", "disposition-not-picked", "roster", "no Force Disposition selected")
    else:
        recorded = [d for d in detachments if d.get("force_dispositions") is not None]
        if recorded and not any(force_disposition in d["force_dispositions"] for d in recorded):
            push(
                "warn",
                "disposition-invalid",
                force_disposition,
                f"{force_disposition} is not offered by any selected detachment",
            )

    # --- Detachment tag uniqueness (one per shared tag). ----------------------
    tag_counts: dict[str, int] = {}
    for d in detachments:
        for t in d.get("tags") or []:
            tag_counts[t] = tag_counts.get(t, 0) + 1
    for tag, n in tag_counts.items():
        if n > 1:
            err("detachment-tag-conflict", tag, f"{n} detachments share the '{tag}' tag")

    # --- Detachment restrictions (required/excluded army keywords, per unit). -
    for d in detachments:
        restrictions = d.get("restrictions")
        if not restrictions:
            continue
        for idx, su in enumerate(spec_units):
            view = views[idx]
            if view is None:
                continue
            kws = _keyword_set(
                view.raw,
                army_keywords,
                army_keyword_set,
                detachment_ids,
                su.get("keyword_overrides") or [],
            )
            if any(k not in kws for k in (restrictions.get("required_keywords") or [])):
                err(
                    "detachment-restriction-required",
                    view.id,
                    f"{view.id} lacks a keyword required by {d['id']}",
                    idx,
                )
            if any(k in kws for k in (restrictions.get("excluded_keywords") or [])):
                err(
                    "detachment-restriction-excluded",
                    view.id,
                    f"{view.id} carries a keyword excluded by {d['id']}",
                    idx,
                )

    # --- Faction exclusions (a generic unit barred from this army's chapter). --
    # The shared Space Marine pool can't drop a generic datasheet for one chapter,
    # so a removed-without-replacement unit (e.g. Librarians for Black Templars)
    # carries ``excluded_faction_keywords``; it is illegal when the army's faction
    # keywords intersect that list. Mirror of TS ``unit-excluded-from-faction``.
    faction_view = dataset.factions.get(faction_id) if faction_id else None
    faction_keywords = set((faction_view.raw.get("keywords") if faction_view else None) or [])
    if faction_keywords:
        for idx, _su in enumerate(spec_units):
            view = views[idx]
            if view is None:
                continue
            barred = [
                k
                for k in (view.raw.get("excluded_faction_keywords") or [])
                if k in faction_keywords
            ]
            if barred:
                err(
                    "unit-excluded-from-faction",
                    view.id,
                    f"{view.id} cannot be taken by {faction_id} (barred by {', '.join(barred)})",
                    idx,
                )

    # --- Warlord present (exactly one). ---------------------------------------
    warlords = sum(1 for su in spec_units if su.get("is_warlord") is True)
    if warlords == 0:
        err("no-warlord", "roster", "army has no warlord")
    elif warlords > 1:
        err("multiple-warlords", "roster", f"army has {warlords} warlords")

    # --- Unit minimums (e.g. Houndpack: 3+ WAR DOG units). --------------------
    for d in detachments:
        for um in d.get("unit_minimums") or []:
            count = sum(
                1
                for idx, view in enumerate(views)
                if view is not None
                and um["keyword"]
                in _keyword_set(
                    view.raw,
                    army_keywords,
                    army_keyword_set,
                    detachment_ids,
                    spec_units[idx].get("keyword_overrides") or [],
                )
            )
            if count < um["min"]:
                err(
                    "unit-minimum-unmet",
                    um["keyword"],
                    f"{d['id']} requires {um['min']}+ {um['keyword']} units, found {count}",
                )

    army.sort(key=lambda v: (v["code"], v["id"]))
    return {"units": units, "army": army}


def check_roster(roster: dict[str, Any], dataset: Dataset) -> dict[str, Any]:
    """Whole-army legality for a resolved ``Roster`` dict. Lowers it to the
    normalised spec :func:`validate_roster_core` consumes (mirror of TS
    ``checkRoster``)."""
    units = []
    for u in roster.get("units") or []:
        counts: dict[str, int] = {}
        for w in u.get("wargear") or []:
            wid = w.get("ref", {}).get("id")
            if wid is None:
                continue
            counts[wid] = counts.get(wid, 0) + w.get("count", 0)
        leader_attachment = u.get("leader_attachment")
        leader_bodyguard_id = (
            leader_attachment.get("bodyguard_ref", {}).get("id") if leader_attachment else None
        )
        enhancement = u.get("enhancement")
        units.append(
            {
                "unit_id": (u.get("ref") or {}).get("id") or "",
                "model_count": u.get("model_count") or 0,
                "is_warlord": u.get("is_warlord") is True,
                "enhancement_id": enhancement.get("id") if enhancement else None,
                "leader_bodyguard_id": leader_bodyguard_id,
                "keyword_overrides": u.get("keyword_overrides") or [],
                "counts": counts,
            }
        )
    spec = {
        "faction_id": roster.get("faction_id"),
        "battle_size": roster.get("battle_size"),
        "force_disposition": roster.get("force_disposition"),
        "detachment_ids": [
            d["ref"]["id"]
            for d in (roster.get("detachments") or [])
            if (d.get("ref") or {}).get("id") is not None
        ],
        "units": units,
    }
    return validate_roster_core(spec, dataset)
