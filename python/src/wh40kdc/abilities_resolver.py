"""Walks the dataset for every ability that could apply to a chosen unit in a
chosen phase.

Resolution order — stable for snapshot tests:

1. **army** — faction-scoped abilities whose ``ability_type`` is ``"faction"``.
2. **detachment** — abilities authored against the detachment.
3. **detachment-stratagem** — stratagems on the detachment, each yielding the
   ability referenced by ``stratagem.ability_id`` (if any).
4. **unit** — abilities listed in ``unit.ability_ids``.
5. **attached** — abilities of each attached member (pulled in full).
6. **support** — abilities on supporting units whose scope range is an aura.

Each step phase-filters via the ``Dataset.phases_for`` index.

Python mirror of ``tools/src/abilities-resolver/resolver.ts``. Entries are
dicts ``{"ability": AbilityView, "source": {...}, "phases": [...]}``; the
corpus compares ability-id sets per source kind.
"""

from __future__ import annotations

from typing import Any

from wh40kdc.data.dataset import Dataset
from wh40kdc.data.entities import AbilityView, UnitView


def resolve_eligible_abilities(
    dataset: Dataset, input: dict[str, Any], phase: str
) -> list[dict[str, Any]]:
    """Compute the eligible-ability list for one (unit, phase)."""

    # Resolve units within the faction when one is known. Unit ids are shared
    # across factions, so a faction-blind `get` can return the wrong faction's
    # copy — and with it the wrong intrinsic abilities/keywords.
    def resolve_unit(id: str, fid: str | None) -> UnitView | None:
        scoped = dataset.units.get_in_faction(id, fid) if fid else None
        return scoped if scoped is not None else dataset.units.get_any(id)

    unit = resolve_unit(input["unitId"], input.get("factionId"))
    if unit is None:
        return []
    faction_id = input.get("factionId") or unit.raw.get("faction_id")
    seen: set[str] = set()
    out: list[dict[str, Any]] = []

    def push_unique(entry: dict[str, Any]) -> None:
        key = f"{entry['source']['kind']}::{entry['ability'].id}"
        if key in seen:
            return
        seen.add(key)
        out.append(entry)

    def phase_matches(ability: AbilityView) -> bool:
        # An ability with no phase-mapping is permissive — surface it
        # everywhere; the translator gates conditional-on-phase internally.
        phases = ability.phases
        return not phases or phase in phases

    def intersect(phases: list[str]) -> list[str]:
        return [phase] if phase in phases else phases

    # 1. Army — faction-scoped abilities (faction rule + any other faction-typed).
    for ability in dataset.abilities.by_faction(faction_id or ""):
        if ability.raw.get("ability_type") != "faction":
            continue
        if not phase_matches(ability):
            continue
        push_unique(
            {"ability": ability, "source": {"kind": "army"}, "phases": intersect(ability.phases)}
        )

    detachment_id = input.get("detachmentId")
    if detachment_id:
        # 2. Detachment abilities — abilities whose detachment_id matches.
        for ability in dataset.abilities:
            if ability.raw.get("ability_type") != "detachment":
                continue
            if ability.raw.get("detachment_id") != detachment_id:
                continue
            if not phase_matches(ability):
                continue
            push_unique(
                {
                    "ability": ability,
                    "source": {"kind": "detachment", "detachmentId": detachment_id},
                    "phases": intersect(ability.phases),
                }
            )

        # 3. Detachment stratagems.
        # Shared Codex detachment ids resolve within the requesting faction,
        # falling back first-wins (mirrors the TS resolver).
        detachment = dataset.detachments.get_in_faction(
            detachment_id, faction_id or ""
        ) or dataset.detachments.get_any(detachment_id)
        if detachment is not None:
            for strat_id in detachment.get("stratagem_ids") or []:
                stratagem = dataset.stratagems.get(strat_id)
                if stratagem is None:
                    continue
                strat_phases = stratagem.get("phases")
                if not strat_phases or phase not in strat_phases:
                    continue
                ability_id = stratagem.get("ability_id")
                # Stratagem ability ids are detachment-qualified but the
                # ability copies are still replicated per faction (SM
                # chapters) — prefer the resolving faction's copy, falling
                # back for shared pools.
                strat_ability = (
                    dataset.abilities.get_in_faction(ability_id, faction_id or "")
                    or dataset.abilities.get_any(ability_id)
                    if ability_id is not None
                    else None
                )
                if strat_ability is None:
                    continue
                push_unique(
                    {
                        "ability": strat_ability,
                        "source": {
                            "kind": "detachment-stratagem",
                            "stratagemId": stratagem["id"],
                            "cpCost": stratagem["cp_cost"],
                        },
                        # The stratagem's printed phase governs eligibility.
                        "phases": [phase],
                    }
                )

    # 4. Unit's own abilities.
    for ability in unit.abilities:
        if not phase_matches(ability):
            continue
        push_unique(
            {
                "ability": ability,
                "source": {"kind": "unit", "unitId": input["unitId"]},
                "phases": intersect(ability.phases),
            }
        )

    # 5. Attached members — the combined unit pools every member's abilities,
    # pulled in full (not aura-filtered like step 6).
    for member_id in input.get("attachedUnitIds") or []:
        member = resolve_unit(member_id, faction_id)
        if member is None:
            continue
        for ability in member.abilities:
            if not phase_matches(ability):
                continue
            push_unique(
                {
                    "ability": ability,
                    "source": {"kind": "attached", "unitId": member_id},
                    "phases": intersect(ability.phases),
                }
            )

    # 6. Supporting units — only aura-scoped abilities.
    for support_id in input.get("supportingUnitIds") or []:
        supporter = resolve_unit(support_id, faction_id)
        if supporter is None:
            continue
        for ability in supporter.abilities:
            if not phase_matches(ability):
                continue
            if not _is_aura_scope((ability.raw.get("scope") or {}).get("range")):
                continue
            push_unique(
                {
                    "ability": ability,
                    "source": {"kind": "support", "sourceUnitId": support_id},
                    "phases": intersect(ability.phases),
                }
            )

    return out


def _is_aura_scope(range_: Any) -> bool:
    if not isinstance(range_, str):
        return False
    return range_.startswith("aura-") or range_ in ("any-on-battlefield", "any-visible")
