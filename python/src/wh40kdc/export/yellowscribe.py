"""Yellowscribe (.ros) serializer — Python mirror of ``tools/src/export/yellowscribe.ts``.

Emits a BattleScribe-compatible ``.ros`` XML document that Yellowscribe
(github.com/ThePants999/Yellowscribe) ingests to build an army in Tabletop
Simulator.

Unlike every other exporter this one is **Dataset-backed**: the Roster carries
only entity ids/counts/points, but Yellowscribe needs full datasheet stat lines,
weapon profiles, keywords, and ability text for its TTS tooltips. So this
serializer resolves each unit against the Dataset and reads stats/weapons/
abilities off the linked views. Output is byte-identical to the TS oracle,
pinned by ``conformance/roster/*/expected.yellowscribe.ros``.

**IP boundary.** No GW rules prose is emitted — ability descriptions come from
the conformance-pinned DSL describer (:meth:`AbilityView.describe`); the dataset
stores no rules text. Everything else is a numeric fact or a community name.

See the TS module for the full Yellowscribe ``.ros`` contract and determinism
rules (no sorting, fixed attribute order, 2-space indent + LF, deterministic
``entityId + index`` ids, integer stats plain / string stats verbatim, one
shared XML escaper).
"""

from __future__ import annotations

from typing import Any

from wh40kdc.data.dataset import Dataset
from wh40kdc.export.helpers import title_case_id

#: BattleScribe's Warhammer 40,000 10th-edition game-system id — Yellowscribe
#: rejects a roster whose ``gameSystemId`` isn't this.
_GAME_SYSTEM_ID = "sys-352e-adc2-7639-d6a9"
_GAME_SYSTEM_NAME = "Warhammer 40,000"


# --------------------------------------------------------------------------
# Minimal deterministic XML tree + renderer (no library — a library would
# reorder attributes or normalise whitespace, breaking byte-parity).
# --------------------------------------------------------------------------


class _El:
    __slots__ = ("attrs", "children", "tag", "text")

    def __init__(
        self,
        tag: str,
        attrs: list[tuple[str, str]],
        children: list[_El],
        text: str | None = None,
    ) -> None:
        self.tag = tag
        self.attrs = attrs
        self.children = children
        self.text = text


def _el(tag: str, attrs: list[tuple[str, str]], children: list[_El]) -> _El:
    return _El(tag, attrs, children)


def _leaf(tag: str, attrs: list[tuple[str, str]], text: str) -> _El:
    return _El(tag, attrs, [], text)


def _esc_text(s: str) -> str:
    """Escape text content: ``& < >``."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _esc_attr(s: str) -> str:
    """Escape an attribute value: ``& < > "``."""
    return _esc_text(s).replace('"', "&quot;")


def _render_attrs(attrs: list[tuple[str, str]]) -> str:
    return "".join(f' {k}="{_esc_attr(v)}"' for k, v in attrs)


def _render(node: _El, depth: int) -> str:
    indent = "  " * depth
    open_ = f"<{node.tag}{_render_attrs(node.attrs)}"
    if node.text is not None:
        return f"{indent}{open_}>{_esc_text(node.text)}</{node.tag}>"
    if not node.children:
        return f"{indent}{open_}/>"
    inner = "\n".join(_render(c, depth + 1) for c in node.children)
    return f"{indent}{open_}>\n{inner}\n{indent}</{node.tag}>"


# --------------------------------------------------------------------------
# Stat-line rendering (datasheet conventions; deterministic across ports).
# --------------------------------------------------------------------------


def _fmt_move(m: Any) -> str:
    """Movement: append the inch mark unless the stored value already has one."""
    s = str(m)
    return s if s.endswith('"') else f'{s}"'


def _fmt_target(v: Any) -> str:
    """A target-number stat (Sv, Ld, BS, WS): append ``+``."""
    return f"{v}+"


def _keyword_label(name: str, parameters: dict[str, Any] | None) -> str:
    """A weapon keyword's display label: ``Anti-Infantry 4+``, ``Rapid Fire 1``,
    or a bare ``Devastating Wounds``."""
    if parameters:
        tk = parameters.get("target_keyword")
        th = parameters.get("threshold")
        if isinstance(tk, str) and isinstance(th, (int, str)) and not isinstance(th, bool):
            return f"{name}-{tk} {th}+"
        value = parameters.get("value")
        if value is not None:
            return f"{name} {value}"
    return name


# --------------------------------------------------------------------------
# Profile builders.
# --------------------------------------------------------------------------


def _unit_stat_profiles(view: Any) -> list[_El]:
    """The ``<profile typeName="Unit">`` stat line(s) — one per unit stat profile
    (degrading/wound-track units carry several)."""
    out: list[_El] = []
    for i, p in enumerate(view.raw["profiles"]):
        name = p.get("name") or (view.name if i == 0 else f"{view.name} ({i + 1})")
        out.append(
            _el(
                "profile",
                [("name", name), ("typeName", "Unit")],
                [
                    _el(
                        "characteristics",
                        [],
                        [
                            _leaf("characteristic", [("name", "M")], _fmt_move(p["M"])),
                            _leaf("characteristic", [("name", "T")], str(p["T"])),
                            _leaf("characteristic", [("name", "SV")], _fmt_target(p["Sv"])),
                            _leaf("characteristic", [("name", "W")], str(p["W"])),
                            _leaf("characteristic", [("name", "LD")], _fmt_target(p["Ld"])),
                            _leaf("characteristic", [("name", "OC")], str(p["OC"])),
                        ],
                    ),
                ],
            )
        )
    return out


def _ability_profile(name: str, description: str) -> _El:
    return _el(
        "profile",
        [("name", name), ("typeName", "Abilities")],
        [
            _el(
                "characteristics",
                [],
                [
                    _leaf("characteristic", [("name", "Description")], description),
                ],
            ),
        ],
    )


def _ability_profiles(view: Any) -> list[_El]:
    """``<profile typeName="Abilities">`` entries: the invuln save (a numeric fact)
    followed by each ability's describer-rendered text."""
    out: list[_El] = []
    invuln = view.profile_at(0).get("invuln_sv")
    if invuln is not None:
        out.append(_ability_profile("Invulnerable Save", f"{invuln}+ invulnerable save"))
    for ability in view.abilities:
        out.append(_ability_profile(ability.name, ability.describe()))
    return out


def _weapon_profiles(weapon: Any) -> list[_El]:
    """A weapon's ``<profile>`` list — one per weapon stat profile. Ranged weapons
    carry ``BS``, melee carry ``WS`` and a ``Melee`` range."""
    ranged = weapon.raw["type"] == "ranged"
    type_name = "Ranged Weapons" if ranged else "Melee Weapons"
    out: list[_El] = []
    for i, p in enumerate(weapon.raw["profiles"]):
        stats = p["stats"]
        rng = _fmt_move(p.get("range") if p.get("range") is not None else 0) if ranged else "Melee"
        skill_name = "BS" if ranged else "WS"
        skill = stats.get("BS") if ranged else stats.get("WS")
        keywords = ", ".join(
            _keyword_label(k["keyword"].name, k["parameters"]) for k in weapon.keywords_at(i)
        )
        out.append(
            _el(
                "profile",
                [("name", p["name"]), ("typeName", type_name)],
                [
                    _el(
                        "characteristics",
                        [],
                        [
                            _leaf("characteristic", [("name", "Range")], rng),
                            _leaf("characteristic", [("name", "A")], str(stats["A"])),
                            _leaf(
                                "characteristic",
                                [("name", skill_name)],
                                _fmt_target(skill)
                                if isinstance(skill, int) and not isinstance(skill, bool)
                                else "N/A",
                            ),
                            _leaf("characteristic", [("name", "S")], str(stats["S"])),
                            _leaf("characteristic", [("name", "AP")], str(stats["AP"])),
                            _leaf("characteristic", [("name", "D")], str(stats["D"])),
                            _leaf("characteristic", [("name", "Keywords")], keywords),
                        ],
                    ),
                ],
            )
        )
    return out


# --------------------------------------------------------------------------
# Selection tree.
# --------------------------------------------------------------------------


def _resolve_unit(unit: dict[str, Any], dataset: Dataset, faction_id: str | None) -> Any | None:
    uid = unit["ref"]["id"]
    if uid is None:
        return None
    if faction_id:
        scoped = dataset.units.get_in_faction(uid, faction_id)
        if scoped is not None:
            return scoped
    return dataset.units.get_any(uid)


def _resolve_weapon(w: dict[str, Any], dataset: Dataset, faction_id: str | None) -> Any | None:
    wid = w["ref"]["id"]
    if wid is None:
        return None
    scoped = dataset.weapons.get_in_faction(wid, faction_id) if faction_id else None
    return scoped or dataset.weapons.get_any(wid)


def _upgrade_selection(id_: str, weapon: Any, total_count: int) -> _El:
    """One weapon ``<selection type="upgrade">``. ``number`` is the TOTAL across
    the group's models (Yellowscribe divides it back out by the model count)."""
    return _el(
        "selection",
        [("id", id_), ("name", weapon.name), ("type", "upgrade"), ("number", str(total_count))],
        [_el("profiles", [], _weapon_profiles(weapon))],
    )


def _model_selection(
    id_base: str,
    model_name: str,
    model_count: int,
    wargear: list[dict[str, Any]],
    dataset: Dataset,
    faction_id: str | None,
) -> _El:
    upgrades: list[_El] = []
    for wi, w in enumerate(wargear):
        weapon = _resolve_weapon(w, dataset, faction_id)
        if weapon is None:
            continue  # unresolved weapon — skip (already flagged in diagnostics)
        upgrades.append(_upgrade_selection(f"{id_base}-w{wi}", weapon, w["count"] * model_count))
    children: list[_El] = []
    if upgrades:
        children.append(_el("selections", [], upgrades))
    return _el(
        "selection",
        [("id", id_base), ("name", model_name), ("type", "model"), ("number", str(model_count))],
        children,
    )


def _model_selections(
    unit: dict[str, Any], unit_id: str, view: Any, dataset: Dataset, faction_id: str | None
) -> list[_El]:
    """One ``<selection type="model">`` per loadout group, falling back to a single
    group over the flat ``wargear`` (whose counts are already unit totals)."""
    groups = unit.get("loadout_groups")
    if not groups:
        groups = [{"model_name": None, "count": unit["model_count"], "wargear": unit["wargear"]}]
    return [
        _model_selection(
            f"{unit_id}-m{gi}",
            g["model_name"] or view.name,
            g["count"],
            g["wargear"],
            dataset,
            faction_id,
        )
        for gi, g in enumerate(groups)
    ]


def _categories_el(view: Any) -> _El | None:
    """Unit categories: faction keywords (prefixed ``Faction: ``) then general
    keywords, in stored order."""
    cats: list[_El] = []
    for k in view.raw.get("faction_keywords") or []:
        cats.append(_el("category", [("name", f"Faction: {k}")], []))
    for k in view.raw.get("keywords") or []:
        cats.append(_el("category", [("name", k)], []))
    return _el("categories", [], cats) if cats else None


def _unit_selection(
    unit: dict[str, Any], index: int, dataset: Dataset, faction_id: str | None
) -> _El | None:
    """One unit ``<selection type="unit">``. ``None`` for a unit that doesn't
    resolve (no datasheet to emit stats from)."""
    view = _resolve_unit(unit, dataset, faction_id)
    if view is None:
        return None
    unit_id = f"unit{index}"

    profiles = _unit_stat_profiles(view) + _ability_profiles(view)
    children: list[_El] = [_el("profiles", [], profiles)]

    cats = _categories_el(view)
    if cats is not None:
        children.append(cats)

    children.append(
        _el("selections", [], _model_selections(unit, unit_id, view, dataset, faction_id))
    )

    return _el(
        "selection",
        [("id", unit_id), ("name", unit["ref"]["raw_name"]), ("type", "unit"), ("number", "1")],
        children,
    )


def serialize_yellowscribe(roster: dict[str, Any], dataset: Dataset) -> str:
    """Serialize a Roster into Yellowscribe-ingestible BattleScribe ``.ros`` XML."""
    faction_id = roster.get("faction_id")
    faction_name = title_case_id(faction_id) or "Unknown"

    unit_selections: list[_El] = []
    for i, unit in enumerate(roster["units"]):
        sel = _unit_selection(unit, i, dataset, faction_id)
        if sel is not None:
            unit_selections.append(sel)

    force = _el(
        "force",
        [("id", "force0"), ("name", faction_name), ("catalogueName", faction_name)],
        [_el("selections", [], unit_selections)],
    )

    roster_el = _el(
        "roster",
        [
            ("id", "roster0"),
            ("name", roster["name"]),
            ("gameSystemId", _GAME_SYSTEM_ID),
            ("gameSystemName", _GAME_SYSTEM_NAME),
        ],
        [_el("forces", [], [force])],
    )

    return f'<?xml version="1.0" encoding="utf-8"?>\n{_render(roster_el, 0)}\n'
