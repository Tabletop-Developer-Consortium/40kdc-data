"""Terrain layout resolver — turns a terrain layout (template references +
centroid-anchored placements + rotation/mirror) into absolute board-space
polygon vertices.

This is the shared geometry contract pinned by the
``conformance/terrain-resolver`` corpus; vertices are 4-dp rounded with JS
``Math.round`` semantics (half away from zero toward +∞), compared with
±5e-4 tolerance.

Transform contract: frames are board inches, origin at a board corner,
**y-down**. Local → board, for an unparented piece, is
``mirror → rotate → translate`` about the footprint's polygon-area centroid::

    board = position + R_cw(rotation) · M(mirror) · (v - centroid)

A feature with a ``parent_area_id`` (or a template's composed feature) is
first placed in the parent area's centroid-local frame, then carried through
the area's own placement.

Emission order (a pinned invariant): pieces in ``layout.pieces`` order; an
area template's composed features emit immediately after their area, in
template-declaration order.

Python mirror of ``tools/src/terrain/resolve.ts``.
"""

from __future__ import annotations

import math
from typing import Any

Vec2 = dict[str, float]

_DEG = math.pi / 180


class TerrainResolveError(ValueError):
    pass


def footprint_vertices(fp: dict[str, Any]) -> list[Vec2]:
    """A footprint's polygon vertices in natural local (y-down) coordinates."""
    fp_type = fp.get("type")
    if fp_type == "rectangle":
        return [
            {"x": 0, "y": 0},
            {"x": fp["width"], "y": 0},
            {"x": fp["width"], "y": fp["height"]},
            {"x": 0, "y": fp["height"]},
        ]
    if fp_type == "right-triangle":
        # Right angle at the local origin, legs along +x and +y.
        return [
            {"x": 0, "y": 0},
            {"x": fp["width"], "y": 0},
            {"x": 0, "y": fp["height"]},
        ]
    if fp_type == "polygon":
        return [{"x": p["x"], "y": p["y"]} for p in fp["points"]]
    raise TerrainResolveError(f"unknown footprint type: {fp_type}")


def polygon_centroid(verts: list[Vec2]) -> Vec2:
    """Polygon area centroid (shoelace). Falls back to the vertex mean when
    the polygon is degenerate (zero signed area) so the resolver never
    divides by zero."""
    n = len(verts)
    if n == 0:
        return {"x": 0, "y": 0}
    twice_area = 0.0
    cx = 0.0
    cy = 0.0
    for i in range(n):
        a = verts[i]
        b = verts[(i + 1) % n]
        cross = a["x"] * b["y"] - b["x"] * a["y"]
        twice_area += cross
        cx += (a["x"] + b["x"]) * cross
        cy += (a["y"] + b["y"]) * cross
    if twice_area == 0:
        mean_x = sum(v["x"] for v in verts)
        mean_y = sum(v["y"] for v in verts)
        return {"x": mean_x / n, "y": mean_y / n}
    return {"x": cx / (3 * twice_area), "y": cy / (3 * twice_area)}


def _apply_mirror(v: Vec2, m: str) -> Vec2:
    if m == "horizontal":
        return {"x": -v["x"], "y": v["y"]}
    if m == "vertical":
        return {"x": v["x"], "y": -v["y"]}
    return v


def _rotate_cw(v: Vec2, deg: float) -> Vec2:
    """Clockwise rotation by ``deg`` degrees in the y-down frame."""
    if deg == 0:
        return {"x": v["x"], "y": v["y"]}
    r = deg * _DEG
    c = math.cos(r)
    s = math.sin(r)
    return {"x": c * v["x"] - s * v["y"], "y": s * v["x"] + c * v["y"]}


def _orient(v: Vec2, rotation: float, mirror: str) -> Vec2:
    """mirror → rotate (no translation). The orientation-only part of a placement."""
    return _rotate_cw(_apply_mirror(v, mirror), rotation)


def oriented_offsets(footprint: dict[str, Any], rotation: float, mirror: str) -> list[Vec2]:
    """The board-space offset of each footprint vertex from the piece
    centroid, after mirror + rotation but before translation."""
    verts = footprint_vertices(footprint)
    c = polygon_centroid(verts)
    return [_orient({"x": v["x"] - c["x"], "y": v["y"] - c["y"]}, rotation, mirror) for v in verts]


def _place_footprint(
    fp: dict[str, Any], position: Vec2, rotation: float, mirror: str
) -> list[Vec2]:
    """Place a footprint's local vertices into a target frame: recenter on
    the footprint centroid, mirror, rotate, then translate so the centroid
    lands on ``position``."""
    verts = footprint_vertices(fp)
    c = polygon_centroid(verts)
    out = []
    for v in verts:
        o = _orient({"x": v["x"] - c["x"], "y": v["y"] - c["y"]}, rotation, mirror)
        out.append({"x": o["x"] + position["x"], "y": o["y"] + position["y"]})
    return out


def _js_round(x: float) -> float:
    """JS ``Math.round``: half rounds toward +∞ (Python ``round`` is
    banker's)."""
    return math.floor(x + 0.5)


def _round4(v: Vec2) -> Vec2:
    return {"x": _js_round(v["x"] * 1e4) / 1e4, "y": _js_round(v["y"] * 1e4) / 1e4}


def resolve_layout(layout: dict[str, Any], templates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Resolve a layout to absolute board-space vertices per piece.

    ``templates`` is the catalog a piece's ``template`` references resolve
    against. Raises :class:`TerrainResolveError` for unknown templates or
    parents.
    """
    by_id = {t["id"]: t for t in templates}

    pieces = layout.get("pieces") or []
    areas_by_id = {p["id"]: p for p in pieces if p.get("id")}

    def footprint_of(piece: dict[str, Any], where: str) -> dict[str, Any]:
        if piece.get("footprint"):
            return piece["footprint"]
        if piece.get("template"):
            t = by_id.get(piece["template"])
            if t is None:
                raise TerrainResolveError(f'{where}: unknown template "{piece["template"]}"')
            return t["footprint"]
        raise TerrainResolveError(f"{where}: piece has neither footprint nor template")

    def resolved_id_name(piece: dict[str, Any]) -> dict[str, Any]:
        return {"id": piece.get("id"), "name": piece.get("name")}

    out: list[dict[str, Any]] = []

    for piece in pieces:
        where = piece.get("id") or piece.get("name") or "<piece>"
        fp = footprint_of(piece, where)
        rotation = piece.get("rotation_degrees") or 0
        mirror = piece.get("mirror") or "none"
        piece_type = piece.get("piece_type") or (
            "feature" if piece.get("parent_area_id") else "area"
        )

        if piece.get("parent_area_id"):
            # Feature placed in its parent area's centroid-local frame.
            parent = areas_by_id.get(piece["parent_area_id"])
            if parent is None:
                raise TerrainResolveError(
                    f'{where}: unknown parent_area_id "{piece["parent_area_id"]}"'
                )
            area_local = _place_footprint(fp, piece["position"], rotation, mirror)
            a_rot = parent.get("rotation_degrees") or 0
            a_mirror = parent.get("mirror") or "none"
            vertices = []
            for p in area_local:
                o = _orient(p, a_rot, a_mirror)
                vertices.append(
                    _round4(
                        {
                            "x": o["x"] + parent["position"]["x"],
                            "y": o["y"] + parent["position"]["y"],
                        }
                    )
                )
            out.append(
                {
                    **resolved_id_name(piece),
                    "piece_type": piece_type,
                    "floor": piece.get("floor") or 0,
                    "vertices": vertices,
                }
            )
            continue

        # Unparented area or feature: place directly in board space.
        vertices = [_round4(v) for v in _place_footprint(fp, piece["position"], rotation, mirror)]
        out.append(
            {
                **resolved_id_name(piece),
                "piece_type": piece_type,
                "floor": piece.get("floor") or 0,
                "vertices": vertices,
            }
        )

        # Expand an area template's composed features, carried through this
        # area's placement (same composition math as a parented feature).
        if piece.get("template"):
            t = by_id.get(piece["template"])
            for feat in (t or {}).get("features") or []:
                ft = by_id.get(feat["template"])
                if ft is None:
                    raise TerrainResolveError(
                        f"{where}: composed feature references unknown template "
                        f'"{feat["template"]}"'
                    )
                area_local = _place_footprint(
                    ft["footprint"],
                    feat["position"],
                    feat.get("rotation_degrees") or 0,
                    feat.get("mirror") or "none",
                )
                feat_verts = []
                for p in area_local:
                    o = _orient(p, rotation, mirror)
                    feat_verts.append(
                        _round4(
                            {
                                "x": o["x"] + piece["position"]["x"],
                                "y": o["y"] + piece["position"]["y"],
                            }
                        )
                    )
                out.append(
                    {
                        "id": feat.get("id"),
                        "name": ft.get("name"),
                        "piece_type": "feature",
                        "floor": feat.get("floor") or 0,
                        "vertices": feat_verts,
                    }
                )

    return out
