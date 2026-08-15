"""Measurement-keystone derivation — the forward direction of the card solver.

A keystone stores only the author's *selection* (board edge → a feature of
the placed piece); the printed distance is always derived from the resolved
geometry here, so a keystone can never disagree with the layout.

Pinned by the ``conformance/terrain-keystones`` corpus. Distances are raw
inches rounded to 4 dp (the resolver's vertex rounding).

Python mirror of ``tools/src/terrain/keystones.ts``.
"""

from __future__ import annotations

import math
from typing import Any

from wh40kdc.terrain.resolve import resolve_layout

#: The 40kdc standard board extents, in inches (x spans width, y height).
BOARD_INCHES: dict[str, float] = {"width": 60, "height": 44}


class TerrainKeystoneError(ValueError):
    pass


def _js_round(x: float) -> float:
    return math.floor(x + 0.5)


def _round4(n: float) -> float:
    return _js_round(n * 10_000) / 10_000


def _axis_of_edge(edge: str) -> str:
    return "x" if edge in ("left", "right") else "y"


def _ref_coordinate(rp: dict[str, Any], k: dict[str, Any], where: str) -> float:
    """The measured board-space coordinate a keystone's ref resolves to."""
    axis = _axis_of_edge(k["edge"])
    ref = k["ref"]
    if ref.get("kind") == "vertex":
        index = ref["index"]
        vertices = rp["vertices"]
        if not (0 <= index < len(vertices)):
            raise TerrainKeystoneError(
                f"{where}: keystone vertex index {index} out of range ({len(vertices)} vertices)"
            )
        return vertices[index][axis]
    side = ref["side"]
    side_axis = "x" if side in ("min-x", "max-x") else "y"
    if side_axis != axis:
        raise TerrainKeystoneError(
            f'{where}: face "{side}" cannot be measured from the {k["edge"]} edge (axis mismatch)'
        )
    vals = [v[axis] for v in rp["vertices"]]
    return min(vals) if side.startswith("min") else max(vals)


def keystone_measurements(
    layout: dict[str, Any],
    templates: list[dict[str, Any]],
    board: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    """Derive every keystone's printed distance for a layout.

    Pieces resolve via :func:`resolve_layout` (the pinned transform
    contract), then each keystone measures from its board edge to the
    referenced feature of the placed piece: near edges (``left``/``top``)
    read the coordinate directly, far edges (``right``/``bottom``) read the
    remaining extent.

    Raises :class:`TerrainKeystoneError` for a vertex index out of range or
    a face whose axis disagrees with the edge.
    """
    if board is None:
        board = BOARD_INCHES
    resolved = resolve_layout(layout, templates)
    by_template = {t["id"]: t for t in templates}
    pieces = layout.get("pieces") or []
    out: list[dict[str, Any]] = []

    # Walk the emission contract: one entry per explicit piece, in order, with
    # an unparented templated piece followed by its template's composed
    # features.
    cursor = 0
    for i, piece in enumerate(pieces):
        if cursor >= len(resolved):
            raise TerrainKeystoneError(f"piece {i}: resolved emission shorter than layout.pieces")
        rp = resolved[cursor]
        cursor += 1
        if not piece.get("parent_area_id") and piece.get("template"):
            template = by_template.get(piece["template"])
            cursor += len((template or {}).get("features") or [])

        for k in piece.get("keystones") or []:
            where = f"piece {rp['id'] if rp['id'] is not None else i}"
            c = _ref_coordinate(rp, k, where)
            extent = board["width"] if _axis_of_edge(k["edge"]) == "x" else board["height"]
            distance = c if k["edge"] in ("left", "top") else extent - c
            out.append(
                {
                    "piece_index": i,
                    "piece_id": rp["id"],
                    "edge": k["edge"],
                    "ref": k["ref"],
                    "distance": _round4(distance),
                }
            )
    return out
