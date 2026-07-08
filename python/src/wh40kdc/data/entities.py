"""Linked views over the richly-connected entity types.

Each wraps a raw record (a plain dict, mirroring the TS reference operating on
JSON objects) and resolves its relationships lazily against the owning
:class:`~wh40kdc.data.dataset.Dataset`; the full underlying record is always
available via ``.raw``.

Python mirror of ``tools/src/data/entities.ts``. Buff-translation methods
import the cruncher lazily so the data layer stands alone.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from wh40kdc.data.dataset import Dataset


def _resolve_all(ids: list[str] | None, get: Any) -> list[Any]:
    """Resolve a list of ids, dropping any that don't resolve."""
    out = []
    for id_ in ids or []:
        v = get(id_)
        if v is not None:
            out.append(v)
    return out


class UnitView:
    """A unit, linked to its faction, weapons, and abilities."""

    def __init__(self, raw: dict[str, Any], ds: Dataset) -> None:
        #: The full generated ``Unit`` record.
        self.raw = raw
        self._ds = ds

    @property
    def id(self) -> str:
        return self.raw["id"]

    @property
    def name(self) -> str:
        return self.raw["name"]

    @property
    def faction(self) -> FactionView | None:
        """The unit's faction, or ``None`` if its ``faction_id`` is unknown."""
        return self._ds.factions.get(self.raw["faction_id"])

    @property
    def weapons(self) -> list[WeaponView]:
        """Weapons referenced by ``weapon_ids``, resolved within the unit's own
        faction — a bare id shared across factions (e.g. ``close-combat-weapon``)
        resolves to the wielder's own copy (issue #59), falling back to global
        first-wins for a genuinely cross-faction id. Unresolved ids are skipped."""
        faction_id = self.raw.get("faction_id", "")
        return _resolve_all(
            self.raw.get("weapon_ids"),
            lambda id_: self._ds.weapons.get_in_faction(id_, faction_id)
            or self._ds.weapons.get(id_),
        )

    @property
    def abilities(self) -> list[AbilityView]:
        """Abilities referenced by ``ability_ids``, resolved within the unit's
        own faction first — an ability_id shared across factions has
        per-faction copies that diverge. The fallback catches the faction-less
        ``_core`` pool. Unresolved ids are skipped."""
        faction_id = self.raw.get("faction_id", "")
        return _resolve_all(
            self.raw.get("ability_ids"),
            lambda id_: self._ds.abilities.get_in_faction(id_, faction_id)
            or self._ds.abilities.get(id_),
        )

    @property
    def wargear_options(self) -> list[dict[str, Any]]:
        """Wargear options (weapon swaps, add-ons, choices) authored for this unit."""
        return self._ds.wargear_options_of(self.raw)

    def profile_at(self, i: int = 0) -> dict[str, Any]:
        """The stat profile at index ``i`` (default 0)."""
        profiles = self.raw["profiles"]
        if i < 0 or i >= len(profiles):
            raise IndexError(
                f"UnitView({self.raw['id']}).profile_at({i}): "
                f"only {len(profiles)} profile(s) defined"
            )
        return profiles[i]


class AbilityView:
    """An ability, linked to the phases it acts in and the units that have it.

    Phases are not stored on the ability — they live in ``phase-mappings``
    records.
    """

    def __init__(self, raw: dict[str, Any], ds: Dataset) -> None:
        #: The full generated ability record.
        self.raw = raw
        self._ds = ds

    @property
    def id(self) -> str:
        """The ability's id (``ability_id`` in the raw record)."""
        return self.raw["ability_id"]

    @property
    def name(self) -> str:
        return self.raw["name"]

    def describe(self) -> str:
        """Generated plain-English approximation of this ability's effect + scope.

        Rendered from the DSL by the conformance-pinned describer
        (``translate/effect.py``). The dataset carries no rules prose; this is
        the displayable stand-in.
        """
        from wh40kdc.translate.effect import describe_ability

        return describe_ability(self.raw)

    @property
    def phases(self) -> list[str]:
        """Game phases this ability acts in, unioned across its phase-mappings."""
        return self._ds.phases_for("ability", self.raw["ability_id"])

    @property
    def units(self) -> list[UnitView]:
        """Units that list this ability in their ``ability_ids``."""
        return self._ds.units_with_ability(self.raw["ability_id"])

    @property
    def applies_to(self) -> dict[str, Any] | None:
        """The curated ``applies_to`` keyword filter, or ``None`` when this
        ability declares no resolvable unit scope. When present, it names which
        datasheet units the ability benefits — the contract for roster-side
        highlighting (e.g. a detachment rule that only buffs ``POSSESSED``
        units)."""
        return self.raw.get("applies_to")

    def affects_unit(self, unit: UnitView) -> bool:
        """Whether this ability's ``applies_to`` scope includes ``unit`` — true
        iff the unit carries every ``required_keywords`` entry and no
        ``excluded_keywords``, across its ``keywords`` + ``faction_keywords``.
        Always ``False`` when the ability has no ``applies_to``. Pinned by the
        ``conformance/applies-to`` corpus."""
        from wh40kdc.scope import ability_applies_to_unit

        return ability_applies_to_unit(self.raw.get("applies_to"), unit.raw)

    def affected_units(self, candidates: list[UnitView]) -> list[UnitView]:
        """The subset of ``candidates`` (typically a roster's units) this
        ability's ``applies_to`` scope benefits, preserving input order. Empty
        when the ability declares no scope."""
        return [u for u in candidates if self.affects_unit(u)]

    def get_buffs(
        self,
        source: dict[str, Any],
        context: dict[str, Any] | None = None,
        perspective: str = "attacker",
    ) -> list[dict[str, Any]]:
        """Buff stack this ability contributes against ``context``.

        Provenance is tagged via ``source``. DSL branches the buff layer can't
        auto-apply are dropped here; call :meth:`describe_buffs` if you also
        want the diagnostics.
        """
        return self.describe_buffs(source, context, perspective)["applied"]

    def describe_buffs(
        self,
        source: dict[str, Any],
        context: dict[str, Any] | None = None,
        perspective: str = "attacker",
    ) -> dict[str, Any]:
        """Full DSL→Buff translation, including the ``unsupported`` list."""
        from wh40kdc.cruncher.from_dsl import effect_to_buffs

        ctx = context if context is not None else {"phase": "shooting"}
        translated = effect_to_buffs(self.raw.get("effect"), source, ctx, perspective)
        # A range-scoped ability (DSL scope.range_inches, e.g. a "within 18\""
        # reroll) gates on distance to the target. Stamp it here, not in the
        # effect translator, so the effect-translation corpus (bare effects) is
        # unaffected; the gate is permissive until a caller sets distanceInches.
        scope = self.raw.get("scope") or {}
        rng = scope.get("range_inches")
        if not isinstance(rng, (int, float)) or isinstance(rng, bool):
            return translated

        def gate(b: dict[str, Any]) -> dict[str, Any]:
            return {
                **b,
                "applicableWhen": {**(b.get("applicableWhen") or {}), "maxRangeInches": rng},
            }

        return {
            "applied": [gate(b) for b in translated.get("applied", [])],
            "unsupported": translated.get("unsupported", []),
            "activatable": [
                {**a, "buffs": [gate(b) for b in a.get("buffs", [])]}
                for a in translated.get("activatable", [])
            ],
        }


class WeaponView:
    """A weapon, linked to the units that carry it."""

    def __init__(self, raw: dict[str, Any], ds: Dataset) -> None:
        #: The full generated ``Weapon`` record.
        self.raw = raw
        self._ds = ds

    @property
    def id(self) -> str:
        return self.raw["id"]

    @property
    def name(self) -> str:
        return self.raw["name"]

    @property
    def units(self) -> list[UnitView]:
        """Units that list this weapon in their ``weapon_ids``."""
        return self._ds.units_with_weapon(self.raw["id"])

    def profile_at(self, i: int = 0) -> dict[str, Any]:
        """The stat profile at index ``i`` (default 0)."""
        profiles = self.raw["profiles"]
        if i < 0 or i >= len(profiles):
            raise IndexError(
                f"WeaponView({self.raw['id']}).profile_at({i}): "
                f"only {len(profiles)} profile(s) defined"
            )
        return profiles[i]

    def keywords_at(self, i: int = 0) -> list[dict[str, Any]]:
        """Catalog views for each keyword referenced by profile ``i``.

        Each entry is ``{"keyword": WeaponKeywordView, "parameters": ...}``;
        unresolved keyword ids are skipped.
        """
        profile = self.profile_at(i)
        out = []
        for ref in profile.get("keywords") or []:
            view = self._ds.weapon_keywords.get(ref["keyword_id"])
            if view is None:
                continue
            out.append({"keyword": view, "parameters": ref.get("parameters")})
        return out

    def profile_buffs(self, i: int | None, context: dict[str, Any]) -> list[dict[str, Any]]:
        """Buffs contributed by profile ``i``'s intrinsic keywords against ``context``."""
        from wh40kdc.cruncher.from_keyword import buffs_from_keyword

        index = i if i is not None else 0
        out: list[dict[str, Any]] = []
        for entry in self.keywords_at(index):
            keyword = entry["keyword"]
            out.extend(
                buffs_from_keyword(
                    keyword_id=keyword.id,
                    weapon_id=self.raw["id"],
                    effect=keyword.raw.get("effect"),
                    parameters=entry["parameters"],
                    context=context,
                )
            )
        return out


class WeaponKeywordView:
    """A weapon-keyword catalog entry, linked to the weapons that reference it."""

    def __init__(self, raw: dict[str, Any], ds: Dataset) -> None:
        #: The full generated ``WeaponKeyword`` record.
        self.raw = raw
        self._ds = ds

    @property
    def id(self) -> str:
        return self.raw["id"]

    @property
    def name(self) -> str:
        return self.raw["name"]

    @property
    def weapons(self) -> list[WeaponView]:
        """Weapons whose profiles reference this keyword id."""
        return self._ds.weapons_with_keyword(self.raw["id"])

    def get_buffs(
        self,
        parameters: dict[str, Any] | None,
        weapon_id: str,
        context: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Buff contributions from this catalog entry, for one reference site."""
        from wh40kdc.cruncher.from_keyword import buffs_from_keyword

        return buffs_from_keyword(
            keyword_id=self.raw["id"],
            weapon_id=weapon_id,
            effect=self.raw.get("effect"),
            parameters=parameters,
            context=context,
        )


class FactionView:
    """A faction, linked to its units and the records scoped to it."""

    def __init__(self, raw: dict[str, Any], ds: Dataset) -> None:
        #: The full generated ``Faction`` record.
        self.raw = raw
        self._ds = ds

    @property
    def id(self) -> str:
        return self.raw["id"]

    @property
    def name(self) -> str:
        return self.raw["name"]

    @property
    def logo_url(self) -> str | None:
        """URL to the faction's logo/emblem image, or ``None`` if unset."""
        return self.raw.get("logo_url")

    @property
    def units(self) -> list[UnitView]:
        """Units whose ``faction_id`` is this faction (may be empty for successors)."""
        return self._ds.units.by_faction(self.raw["id"])

    @property
    def abilities(self) -> list[AbilityView]:
        """Faction-scoped abilities (abilities whose ``faction_id`` is this faction)."""
        return self._ds.abilities.by_faction(self.raw["id"])

    @property
    def weapons(self) -> list[WeaponView]:
        """Distinct weapons carried by this faction's units."""
        seen: set[str] = set()
        out: list[WeaponView] = []
        for unit in self.units:
            for weapon in unit.weapons:
                if weapon.id in seen:
                    continue
                seen.add(weapon.id)
                out.append(weapon)
        return out
