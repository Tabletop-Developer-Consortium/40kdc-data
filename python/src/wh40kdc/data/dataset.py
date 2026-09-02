"""``Dataset`` ties the embedded records together.

It owns every :class:`~wh40kdc.data.collection.Collection`, builds the
cross-entity indexes once, and is the hub the linked views resolve against.

Python mirror of ``tools/src/data/dataset.ts``.
"""

from __future__ import annotations

from typing import Any, TypedDict

from wh40kdc.data.bundle import RawData, empty_raw_data, raw_data
from wh40kdc.data.collection import Collection, id_collection
from wh40kdc.data.entities import (
    AbilityView,
    FactionView,
    UnitView,
    WeaponKeywordView,
    WeaponView,
)
from wh40kdc.share import embedded_registry_aliases


def _buff_source_from_eligible(entry: dict[str, Any]) -> dict[str, Any]:
    """Map an eligible-ability entry back to the BuffSource the translator
    expects."""
    ability_id = entry["ability"].id
    kind = entry["source"]["kind"]
    if kind == "attached":
        return {
            "kind": "ability",
            "abilityId": ability_id,
            "abilityKind": "attached",
            "sourceUnitId": entry["source"]["unitId"],
        }
    if kind == "detachment-stratagem":
        ability_kind = "detachment-stratagem"
    else:
        ability_kind = kind  # army / detachment / unit / support
    return {"kind": "ability", "abilityId": ability_id, "abilityKind": ability_kind}


class ReactiveTrigger(TypedDict):
    """One reactive ability resolved for event dispatch.

    Names the ability's id, the game event its ``trigger`` fires on, the unit
    ids that list the ability (sorted; empty for faction/detachment-rule
    abilities no unit references directly), and the full ``trigger`` block.

    Python mirror of TS ``ReactiveTrigger``.
    """

    ability_id: str
    event: str
    unit_ids: list[str]
    trigger: dict[str, Any]


def _matches_bodyguard_keywords(la: dict[str, Any], unit: dict[str, Any]) -> bool:
    """Whether ``unit`` satisfies an attachment entry's optional keyword eligibility.

    True when the unit's keyword set (``keywords`` ∪ ``faction_keywords``,
    case-insensitive) contains ALL of ``eligible_bodyguard_keywords``. Absent or
    empty keywords never match (the entry then relies solely on
    ``eligible_bodyguard_ids``). Mirror of TS ``matchesBodyguardKeywords``.
    """
    req = la.get("eligible_bodyguard_keywords") or []
    if not req:
        return False
    have = {k.lower() for k in (unit.get("keywords") or []) + (unit.get("faction_keywords") or [])}
    return all(k.lower() in have for k in req)


class Dataset:
    """The whole dataset, with linked accessors over every entity collection."""

    def __init__(self, raw: RawData | None = None) -> None:
        if raw is None:
            raw = empty_raw_data()

        # Richly-linked collections.
        self.units: Collection[dict[str, Any], UnitView] = Collection(
            raw["units"],
            id_of=lambda u: u["id"],
            external_refs_of=lambda u: u.get("external_refs"),
            # The same unit id is shared across factions (e.g.
            # ministorum-priest); keep each faction's copy, collapse only true
            # within-faction duplicates.
            dedupe_key_of=lambda u: f"{u['faction_id']}::{u['id']}",
            name_of=lambda u: u.get("name"),
            aliases_of=lambda u: u.get("aliases"),
            faction_of=lambda u: u.get("faction_id"),
            # Per-faction copies genuinely diverge (points, keywords,
            # profiles), so a faction-less get() of a shared id is a bug —
            # mirror of the TS guard.
            guard_unscoped=True,
            entity_label="unit",
            wrap=lambda u: UnitView(u, self),
        )
        self.weapons: Collection[dict[str, Any], WeaponView] = Collection(
            raw["weapons"],
            id_of=lambda w: w["id"],
            external_refs_of=lambda w: w.get("external_refs"),
            name_of=lambda w: w.get("name"),
            # A bare weapon id is shared across factions with divergent stats; key
            # on (faction_id, id) so every faction's copy is kept and a unit
            # resolves its own faction's weapon (issue #59), not whichever bundled
            # first.
            dedupe_key_of=lambda w: f"{w.get('faction_id', '')}::{w['id']}",
            faction_of=lambda w: w.get("faction_id"),
            # Per-faction copies diverge (stats), so a faction-less get() of a
            # shared id is a bug — catalog/import callsites that genuinely lack
            # faction context opt out via get_any.
            guard_unscoped=True,
            entity_label="weapon",
            wrap=lambda w: WeaponView(w, self),
        )
        self.weapon_keywords: Collection[dict[str, Any], WeaponKeywordView] = Collection(
            raw["weapon_keywords"],
            id_of=lambda k: k["id"],
            name_of=lambda k: k.get("name"),
            wrap=lambda k: WeaponKeywordView(k, self),
        )
        self.factions: Collection[dict[str, Any], FactionView] = Collection(
            raw["factions"],
            id_of=lambda f: f["id"],
            external_refs_of=lambda f: f.get("external_refs"),
            name_of=lambda f: f.get("name"),
            id_aliases=embedded_registry_aliases(),
            wrap=lambda f: FactionView(f, self),
        )
        # An ability_id is shared across factions (each faction's enrichment
        # authors its own copy of e.g. "deadly-demise-d3", and the copies
        # legitimately diverge); dedupe on (faction_id, id) so every faction's
        # copy is retained and a unit resolves its own faction's ability — the
        # same scheme as weapons (issue #59). `faction_id` is stamped at bundle
        # time from the enrichment directory; only the shared `_core` pool
        # stays faction-less, reachable through the first-wins fallback.
        self.abilities: Collection[dict[str, Any], AbilityView] = Collection(
            raw["abilities"],
            id_of=lambda a: a["ability_id"],
            dedupe_key_of=lambda a: f"{a.get('faction_id') or ''}::{a['ability_id']}",
            name_of=lambda a: a.get("name"),
            faction_of=lambda a: a.get("faction_id"),
            # Per-faction copies diverge (DSL fidelity, unit_ids) — same guard
            # as weapons.
            guard_unscoped=True,
            entity_label="ability",
            wrap=lambda a: AbilityView(a, self),
        )

        # Id-bearing collections without bespoke views (records returned as-is).
        self.target_profiles = id_collection(raw["target_profiles"], lambda p: p.get("faction_id"))
        # The generic Codex Space Marine detachments are replicated into every
        # Codex-compatible chapter/supplement view (shared id, distinct faction);
        # keep each faction's copy, collapse only within-faction dupes — mirroring
        # the unit collection. Use by_faction / get_in_faction with a known faction.
        self.detachments = Collection(
            raw["detachments"],
            id_of=lambda d: d["id"],
            external_refs_of=lambda d: d.get("external_refs"),
            name_of=lambda d: d.get("name"),
            dedupe_key_of=lambda d: f"{d['faction_id']}::{d['id']}",
            faction_of=lambda d: d.get("faction_id"),
            id_aliases=embedded_registry_aliases(),
            # Shared detachments diverge per chapter (detachment_rule_id,
            # stratagem_ids, enhancement_ids, detachment_points) — same guard
            # as units.
            guard_unscoped=True,
            entity_label="detachment",
            wrap=lambda d: d,
        )
        # Allied rules aren't owned by one faction; allies_for matches on army_keywords_any.
        self.allied_rules = id_collection(raw["allied_rules"])
        self.enhancements = id_collection(raw["enhancements"])
        self.stratagems = id_collection(raw["stratagems"])
        self.wargear_options = id_collection(raw["wargear_options"])
        self.wargear = id_collection(raw["wargear"])
        self.missions = id_collection(raw["missions"])
        self.mission_matchups = id_collection(raw["mission_matchups"])
        self.mission_cards = id_collection(raw["mission_cards"])
        self.deployment_patterns = id_collection(raw["deployment_patterns"])
        self.force_dispositions = id_collection(raw["force_dispositions"])
        self.terrain_templates = id_collection(raw["terrain_templates"])
        self.terrain_layouts = id_collection(raw["terrain_layouts"])
        self.hull_shapes = id_collection(raw["hull_shapes"])
        self.resource_pools = id_collection(raw["resource_pools"])

        # Id-less collections, exposed as plain lists.
        self.leader_attachments: list[dict[str, Any]] = raw["leader_attachments"]
        self.unit_compositions: list[dict[str, Any]] = raw["unit_compositions"]
        self.game_versions: list[dict[str, Any]] = raw["game_versions"]
        self.interaction_flags: list[dict[str, Any]] = raw["interaction_flags"]
        self.phase_mappings: list[dict[str, Any]] = raw["phase_mappings"]

        # (unit id, faction id) → its composition row; first-wins on duplicates, as
        # the linear search it replaces returned the first hit.
        self._composition_by_unit: dict[tuple[Any, Any], dict[str, Any]] = {}
        for c in self.unit_compositions:
            self._composition_by_unit.setdefault((c.get("unit_id"), c.get("faction_id")), c)

        # `source_type:source_id` → unioned phases.
        self._phase_index: dict[str, list[str]] = {}
        # ability id → units that list it.
        self._units_by_ability: dict[str, list[dict[str, Any]]] = {}
        # weapon id → units that list it.
        self._units_by_weapon: dict[str, list[dict[str, Any]]] = {}
        # weapon-keyword id → weapons whose profiles reference it.
        self._weapons_by_keyword: dict[str, list[dict[str, Any]]] = {}
        # lowercased keyword → units carrying it (keywords ∪ faction_keywords).
        self._units_by_keyword: dict[str, list[dict[str, Any]]] = {}
        # unit id → wargear options authored for it (declared order preserved).
        self._wargear_options_by_unit: dict[str, list[dict[str, Any]]] = {}

        self._build_indexes(raw)

    @staticmethod
    def embedded() -> Dataset:
        """The dataset built from the package's embedded data."""
        return Dataset(raw_data())

    def phases_for(self, source_type: str, source_id: str) -> list[str]:
        """Phases a source acts in, unioned across its phase-mappings."""
        return self._phase_index.get(f"{source_type}:{source_id}", [])

    def resolve_terrain(self, layout: dict[str, Any]) -> list[dict[str, Any]]:
        """Resolve a terrain layout to absolute board-space vertices.

        Uses this dataset's embedded terrain-template catalog — the layout-id →
        renderable-geometry hop. The geometry is pinned by the
        ``terrain-resolver`` conformance corpus.
        """
        from wh40kdc.terrain.resolve import resolve_layout

        return resolve_layout(layout, self.terrain_templates.all)

    def recommended_terrain_layouts(self, pattern: dict[str, Any]) -> list[dict[str, Any]]:
        """The terrain layouts a deployment pattern recommends, in declared order.

        Skips any ids absent from the dataset.
        """
        out = []
        for id_ in pattern.get("recommended_terrain_layout_ids") or []:
            layout = self.terrain_layouts.get(id_)
            if layout is not None:
                out.append(layout)
        return out

    def units_with_ability(self, ability_id: str) -> list[UnitView]:
        """Units that list the given ability id."""
        return [UnitView(u, self) for u in self._units_by_ability.get(ability_id, [])]

    def reactive_triggers(self) -> list[ReactiveTrigger]:
        """Every ability carrying a reactive ``trigger``, sorted by ability id.

        Each entry names the units that list the ability (sorted; empty for
        faction/detachment-rule abilities no unit references directly). Mirror
        of TS ``reactiveTriggers``.
        """
        out: list[ReactiveTrigger] = []
        # The abilities collection retains one copy per faction of a shared
        # ability_id; this aggregation is faction-less (ReactiveTrigger carries
        # no faction), so emit each ability id once — first registered copy
        # wins, matching the collection's own by-id index and the TS mirror.
        seen_ids: set[str] = set()
        for a in self.abilities.all:
            if a.id in seen_ids:
                continue
            seen_ids.add(a.id)
            raw = a.raw.get("trigger")
            if not raw:
                continue
            # `trigger` may be a single object or an array (the ability fires on
            # any); emit one ReactiveTrigger per event so the dispatch index keys
            # them all. Mirror of TS reactiveTriggers.
            triggers = raw if isinstance(raw, list) else [raw]
            unit_ids = sorted(u["id"] for u in self._units_by_ability.get(a.id, []))
            for trigger in triggers:
                if not isinstance(trigger, dict) or trigger.get("event") is None:
                    continue
                out.append(
                    ReactiveTrigger(
                        ability_id=a.id,
                        event=trigger["event"],
                        unit_ids=unit_ids,
                        trigger=trigger,
                    )
                )
        out.sort(key=lambda rt: rt["ability_id"])
        return out

    def trigger_index(self) -> dict[str, list[ReactiveTrigger]]:
        """Dispatch index for event-driven consumers: event -> reactive triggers.

        Keys are inserted in ascending event order and each bucket is sorted by
        ability id (inherited from :meth:`reactive_triggers`), so the structure
        is deterministic across runs. Mirror of TS ``triggerIndex``.
        """
        grouped: dict[str, list[ReactiveTrigger]] = {}
        for rt in self.reactive_triggers():
            grouped.setdefault(rt["event"], []).append(rt)
        return {event: grouped[event] for event in sorted(grouped)}

    def units_with_weapon(self, weapon_id: str) -> list[UnitView]:
        """Units that list the given weapon id."""
        return [UnitView(u, self) for u in self._units_by_weapon.get(weapon_id, [])]

    def weapons_with_keyword(self, keyword_id: str) -> list[WeaponView]:
        """Weapons whose profiles reference the given weapon-keyword id."""
        return [WeaponView(w, self) for w in self._weapons_by_keyword.get(keyword_id, [])]

    def units_with_keyword(self, keyword: str) -> list[UnitView]:
        """Units carrying the given keyword (case-insensitive).

        Matched against the union of each unit's ``keywords`` and
        ``faction_keywords``. Powers a list builder's keyword search bar across
        the whole dataset (so it also surfaces cross-faction ally pools). Mirror
        of TS ``unitsWithKeyword``; pinned by the ``units_with_keyword``
        conformance query.
        """
        return [UnitView(u, self) for u in self._units_by_keyword.get(keyword.lower(), [])]

    def allies_for(
        self, faction_id: str, detachment_ids: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """Allied-rules offered for an army of ``faction_id`` running the given detachments.

        A rule applies when both gates pass: the army gate
        (``army_keywords_any`` empty, or intersecting the faction's keywords) and
        the detachment gate (``detachment_ids`` empty, or at least one listed id
        among ``detachment_ids``).
        Order follows the allied-rules data. Mirror of TS ``alliesFor``; pinned by
        the ``allies_for`` conformance query.
        """
        faction = self.factions.get(faction_id)
        if faction is None:
            return []
        faction_keywords = {k.lower() for k in (faction.raw.get("keywords") or [])}
        detachment_set = set(detachment_ids or [])
        out: list[dict[str, Any]] = []
        for rule in self.allied_rules.all:
            army_any = rule.get("army_keywords_any") or []
            army_gate = not army_any or any(k.lower() in faction_keywords for k in army_any)
            det_ids = rule.get("detachment_ids") or []
            detachment_gate = not det_ids or any(d in detachment_set for d in det_ids)
            if army_gate and detachment_gate:
                out.append(rule)
        return out

    def ally_units_for(self, rule_id: str) -> list[UnitView]:
        """The unit pool an allied-rule grants, sorted by name.

        Starts from the rule's ``source_faction_id`` (if set) or the whole
        dataset, then ANDs every filter the rule sets: ``source_datasheet_ids``
        (explicit id allowlist — primary selector for generated pools), any
        ``source_keywords``, ``required_keywords`` (all present),
        ``excluded_keywords`` (none present), and ``roles``. Empty for an unknown
        rule id. Mirror of TS
        ``allyUnitsFor``; pinned by the ``ally_units_for`` conformance query.
        """
        rule = self.allied_rules.get(rule_id)
        if rule is None:
            return []
        source_faction = rule.get("source_faction_id")
        base = (
            [v.raw for v in self.units.by_faction(source_faction)]
            if source_faction
            else [v.raw for v in self.units.all]
        )
        source_keywords = [k.lower() for k in (rule.get("source_keywords") or [])]
        required = [k.lower() for k in (rule.get("required_keywords") or [])]
        excluded = [k.lower() for k in (rule.get("excluded_keywords") or [])]
        roles = set(rule.get("roles") or [])
        datasheet_ids = set(rule.get("source_datasheet_ids") or [])

        def matches(unit: dict[str, Any]) -> bool:
            have = {
                k.lower()
                for k in (unit.get("keywords") or []) + (unit.get("faction_keywords") or [])
            }
            if datasheet_ids and unit.get("id") not in datasheet_ids:
                return False
            if source_keywords and not any(k in have for k in source_keywords):
                return False
            if required and not all(k in have for k in required):
                return False
            if any(k in have for k in excluded):
                return False
            if roles and unit.get("role") not in roles:
                return False
            return True

        pool = [u for u in base if matches(u)]
        pool.sort(key=lambda u: u["name"])
        return [UnitView(u, self) for u in pool]

    def wargear_options_of(self, unit: dict[str, Any]) -> list[dict[str, Any]]:
        """Wargear options authored for the given unit, in declared order.

        Scoped to the unit's own faction (``(faction_id, unit_id)``): a chassis
        shared across factions reuses the same option ids for different swaps, so the
        lookup never unions across factions. Empty for a unit with no options.
        """
        return self._wargear_options_by_unit.get(f"{unit['faction_id']}::{unit['id']}", [])

    def unit_composition_of(self, unit: dict[str, Any]) -> dict[str, Any] | None:
        """The unit-composition row for the given unit, faction-scoped.

        A shared chassis diverges per faction, so the composition is matched on
        both ``unit_id`` and ``faction_id``. ``None`` when the unit has no
        recorded composition. Mirror of TS ``unitCompositionOf``.
        """
        return self._composition_by_unit.get((unit["id"], unit.get("faction_id")))

    def leaders_attachable_to(self, bodyguard_unit_id: str) -> list[UnitView]:
        """Leaders whose leader-attachment data lists the unit among its bodyguards.

        The attachment is stored on the leader pointing down to its bodyguards,
        so answering "which leaders can attach to this unit?" means scanning
        the attachment list. Sorted by name. Empty for a unit that no leader
        can attach to (including leader units).
        """
        bodyguard = self.units.get_any(bodyguard_unit_id)
        out = []
        for la in self.leader_attachments:
            # Keyword eligibility (e.g. an Inquisitor leading any Imperium
            # Battleline Infantry unit) matches on the bodyguard's keyword set.
            if bodyguard_unit_id not in la.get("eligible_bodyguard_ids", []) and not (
                bodyguard is not None and _matches_bodyguard_keywords(la, bodyguard.raw)
            ):
                continue
            # Attachment data is faction-agnostic (no faction context
            # here); accept first-wins for a shared chassis via get_any.
            unit = self.units.get_any(la["leader_id"])
            if unit is not None:
                out.append(unit)
        return sorted(out, key=lambda u: u.name)

    def bodyguards_attachable_from(self, leader_unit_id: str) -> list[UnitView]:
        """The inverse of :meth:`leaders_attachable_to`, deduped by id, sorted by name.

        Empty for a non-leader unit.
        """
        seen: set[str] = set()
        out: list[UnitView] = []
        for la in self.leader_attachments:
            if la.get("leader_id") != leader_unit_id:
                continue
            for bodyguard_id in la.get("eligible_bodyguard_ids", []):
                # Faction-agnostic attachment data — get_any, as above.
                unit = self.units.get_any(bodyguard_id)
                if unit is None or unit.id in seen:
                    continue
                seen.add(unit.id)
                out.append(unit)
            # Keyword eligibility: every unit whose keyword set contains all of
            # the entry's keywords is also a valid bodyguard (e.g. Imperium
            # Battleline Infantry for an Inquisitor).
            if la.get("eligible_bodyguard_keywords"):
                for unit in self.units.all:
                    if unit.id not in seen and _matches_bodyguard_keywords(la, unit.raw):
                        seen.add(unit.id)
                        out.append(unit)
        return sorted(out, key=lambda u: u.name)

    def eligible_abilities(self, input: dict[str, Any], phase: str) -> list[dict[str, Any]]:
        """Every ability that could apply to the given unit in ``phase``, by source."""
        from wh40kdc.abilities_resolver import resolve_eligible_abilities

        return resolve_eligible_abilities(self, input, phase)

    def buffs_for(self, input: dict[str, Any], context: dict[str, Any]) -> list[dict[str, Any]]:
        """Attacker-perspective buff stack for a (unit, phase) combination.

        Intrinsic weapon-profile keywords plus every eligible ability whose
        DSL effect translates to an attacker-side buff. Only buffs the buff
        layer can express are included — the ``unsupported`` half of the
        translation is dropped here.
        """
        return self._collect_buffs(input, context, "attacker")

    def defensive_buffs_for(
        self, input: dict[str, Any], context: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Defender-perspective buff stack: walks the same eligible-abilities
        set as :meth:`buffs_for` but translates each ability's DSL effect as
        defensive (FNP, save/toughness mods, save rerolls, incoming hit
        penalties). ``weaponProfiles`` are ignored under target perspective."""
        return self._collect_buffs(input, context, "target")

    def stackable_buffs_for(self, input: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        """Enumerate every attacker-side buff a unit could stack in
        ``context`` as toggleable levers plus their activation groups.

        Unlike :meth:`buffs_for` — which returns only the buffs that
        auto-apply — this surfaces the *player decisions* too: stratagems and
        the activatable gates the DSL models as dice-pool options, ``choice``
        branches, or timing-gated activations. Returns
        ``{"buffs": [StackableBuff], "groups": [StackableBuffGroup]}``.
        """
        buffs: list[dict[str, Any]] = []
        groups: dict[str, dict[str, Any]] = {}
        ctx = self._derived_context(input, context)

        # Intrinsic weapon-profile keywords — always on. Weapon ids are
        # shared across factions with divergent stats, so resolve within the
        # input unit's faction (get_any fallback for a cross-faction id).
        weapon_faction = self._weapon_faction(input)
        for ref in input.get("weaponProfiles") or []:
            weapon = (
                self.weapons.get_in_faction(ref["weaponId"], weapon_faction)
                if weapon_faction
                else None
            ) or self.weapons.get_any(ref["weaponId"])
            if weapon is None:
                continue
            wk = weapon.profile_buffs(ref.get("profileIndex"), ctx)
            if not wk:
                continue
            buffs.append(
                {
                    "id": f"weapon:{ref['weaponId']}:{ref['profileIndex']}",
                    "label": f"{weapon.name} keywords",
                    "buffs": wk,
                    "enabled": True,
                    "source": wk[0]["source"],
                }
            )

        for entry in self.eligible_abilities(input, ctx["phase"]):
            source = _buff_source_from_eligible(entry)
            translation = entry["ability"].describe_buffs(source, ctx, "attacker")
            # Stratagems cost CP — opt-in, not on by default.
            is_stratagem = entry["source"]["kind"] == "detachment-stratagem"

            if translation["applied"]:
                buffs.append(
                    {
                        "id": f"{entry['source']['kind']}:{entry['ability'].id}",
                        "label": entry["ability"].name,
                        "buffs": translation["applied"],
                        "enabled": not is_stratagem,
                        "source": source,
                    }
                )

            for act in translation["activatable"]:
                group_id = None
                if act.get("group"):
                    group_id = act["group"]["id"]
                    if group_id not in groups:
                        groups[group_id] = {
                            "id": group_id,
                            "label": entry["ability"].name,
                            "maxActivations": act["group"]["maxActivations"],
                        }
                lever = {
                    "id": act["id"],
                    "label": f"{entry['ability'].name} — {act['label']}",
                    "buffs": act["buffs"],
                    "enabled": False,
                    "source": source,
                }
                if group_id is not None:
                    lever["group"] = group_id
                buffs.append(lever)

        return {"buffs": buffs, "groups": list(groups.values())}

    def _weapon_faction(self, input: dict[str, Any]) -> str | None:
        """The faction to scope ``weaponProfiles`` lookups by: the explicit
        ``factionId`` when given, else the input unit's own faction."""
        faction = input.get("factionId")
        if faction:
            return faction
        unit = self.units.get_any(input.get("unitId") or "")
        return unit.raw.get("faction_id") if unit is not None else None

    def _derived_context(self, input: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        """Clone the caller's context, deriving ``attackerAttached`` from a
        non-empty ``attachedUnitIds`` when not explicitly set."""
        ctx = dict(context)
        if ctx.get("attackerAttached") is None:
            ctx["attackerAttached"] = bool(input.get("attachedUnitIds"))
        return ctx

    def _collect_buffs(
        self, input: dict[str, Any], context: dict[str, Any], perspective: str
    ) -> list[dict[str, Any]]:
        """Shared implementation for buffs_for / defensive_buffs_for."""
        out: list[dict[str, Any]] = []
        ctx = self._derived_context(input, context)

        # Weapon-profile keywords are attacker-only. Faction-scoped like
        # stackable_buffs_for — first-wins would crunch the wrong faction's stats.
        if perspective == "attacker":
            weapon_faction = self._weapon_faction(input)
            for ref in input.get("weaponProfiles") or []:
                weapon = (
                    self.weapons.get_in_faction(ref["weaponId"], weapon_faction)
                    if weapon_faction
                    else None
                ) or self.weapons.get_any(ref["weaponId"])
                if weapon is None:
                    continue
                out.extend(weapon.profile_buffs(ref.get("profileIndex"), ctx))

        opted_in = set(input.get("optedInStratagemIds") or [])
        for entry in self.eligible_abilities(input, ctx["phase"]):
            source_info = entry["source"]
            if (
                source_info["kind"] == "detachment-stratagem"
                and source_info["stratagemId"] not in opted_in
            ):
                continue
            source = _buff_source_from_eligible(entry)
            out.extend(entry["ability"].get_buffs(source, ctx, perspective))

        return out

    def _build_indexes(self, raw: RawData) -> None:
        for pm in raw["phase_mappings"]:
            key = f"{pm['source_type']}:{pm['source_id']}"
            existing = self._phase_index.setdefault(key, [])
            for phase in pm["phases"]:
                if phase not in existing:
                    existing.append(phase)
        for unit in raw["units"]:
            for ability_id in unit.get("ability_ids") or []:
                self._units_by_ability.setdefault(ability_id, []).append(unit)
            for weapon_id in unit.get("weapon_ids") or []:
                self._units_by_weapon.setdefault(weapon_id, []).append(unit)
            seen_kw: set[str] = set()
            for kw in (unit.get("keywords") or []) + (unit.get("faction_keywords") or []):
                key = kw.lower()
                if key in seen_kw:
                    continue
                seen_kw.add(key)
                self._units_by_keyword.setdefault(key, []).append(unit)
        for option in raw["wargear_options"]:
            # Faction-scoped: a chassis shared across factions reuses the same option
            # ids for different swaps, so key on (faction_id, unit_id). Mirrors TS.
            key = f"{option['faction_id']}::{option['unit_id']}"
            self._wargear_options_by_unit.setdefault(key, []).append(option)
        seen_by_keyword: dict[str, set[str]] = {}
        for weapon in raw["weapons"]:
            for profile in weapon["profiles"]:
                for ref in profile.get("keywords") or []:
                    seen = seen_by_keyword.setdefault(ref["keyword_id"], set())
                    if weapon["id"] in seen:
                        continue
                    seen.add(weapon["id"])
                    self._weapons_by_keyword.setdefault(ref["keyword_id"], []).append(weapon)
