import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveLayout,
  type Keystone,
  type TerrainLayout,
  type TerrainTemplate,
} from "../src/terrain/resolve.js";
import { BOARD_INCHES, keystoneMeasurements } from "../src/terrain/keystones.js";
import {
  authorKeystones,
  isAxisAligned,
  keystonePairingViolations,
} from "../src/derive-keystones.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const layouts = JSON.parse(
  readFileSync(join(ROOT, "data", "core", "terrain-layouts.json"), "utf8"),
) as TerrainLayout[];
const templates = JSON.parse(
  readFileSync(join(ROOT, "data", "core", "terrain-templates.json"), "utf8"),
) as TerrainTemplate[];

const bmLayouts = layouts.filter((l) => l.id.startsWith("bm-"));

describe("Battlemaster layout keystone coverage", () => {
  it("covers all 45 layouts", () => {
    expect(bmLayouts).toHaveLength(45);
  });

  it("anchors one corner on straight pieces, two on oblique ones (rotation needs a second point)", () => {
    for (const layout of bmLayouts) {
      for (const piece of layout.pieces ?? []) {
        const anchors = new Set(
          (piece.keystones ?? []).map((k) => (k.ref.kind === "vertex" ? k.ref.index : -1)),
        );
        if (isAxisAligned(piece)) {
          expect(piece.keystones, `${layout.id}/${piece.id}`).toHaveLength(2);
          expect(anchors.size, `${layout.id}/${piece.id} anchors`).toBe(1);
        } else {
          expect(piece.keystones, `${layout.id}/${piece.id}`).toHaveLength(3);
          expect(anchors.size, `${layout.id}/${piece.id} anchors`).toBe(2);
        }
      }
    }
  });

  it("derives an on-board distance for every keystone", () => {
    for (const layout of bmLayouts) {
      const measured = keystoneMeasurements(layout, templates);
      const expected = (layout.pieces ?? []).reduce(
        (n, p) => n + (isAxisAligned(p) ? 2 : 3),
        0,
      );
      expect(measured, layout.id).toHaveLength(expected);
      for (const m of measured) {
        const extent =
          m.edge === "left" || m.edge === "right"
            ? BOARD_INCHES.width
            : BOARD_INCHES.height;
        expect(m.distance, `${layout.id}/${m.piece_id}/${m.edge}`).toBeGreaterThanOrEqual(0);
        expect(m.distance, `${layout.id}/${m.piece_id}/${m.edge}`).toBeLessThanOrEqual(extent);
      }
    }
  });

  it("measures the rotation anchor perpendicular to the anchor pair (the direction rotation actually moves)", () => {
    const byTemplate = new Map(templates.map((t) => [t.id, t] as const));
    for (const layout of bmLayouts) {
      const resolved = resolveLayout(layout, templates);
      let cursor = 0;
      for (const piece of layout.pieces ?? []) {
        const rp = resolved[cursor]!;
        cursor += 1;
        if (!piece.parent_area_id && piece.template) {
          cursor += byTemplate.get(piece.template)?.features?.length ?? 0;
        }
        if (isAxisAligned(piece)) continue;
        const byAnchor = new Map<number, Keystone[]>();
        for (const k of piece.keystones ?? []) {
          if (k.ref.kind !== "vertex") continue;
          byAnchor.set(k.ref.index, [...(byAnchor.get(k.ref.index) ?? []), k]);
        }
        const aEntry = [...byAnchor.entries()].find(([, ks]) => ks.length === 2);
        const bEntry = [...byAnchor.entries()].find(([, ks]) => ks.length === 1);
        expect(aEntry, `${layout.id}/${piece.id} corner anchor`).toBeDefined();
        expect(bEntry, `${layout.id}/${piece.id} rotation anchor`).toBeDefined();
        const a = rp.vertices[aEntry![0]]!;
        const b = rp.vertices[bEntry![0]]!;
        // Rotating about A swings B perpendicular to A→B, so the single
        // measurement at B must run along that perpendicular: a mostly
        // horizontal pair measures to a horizontal (top/bottom) edge and
        // vice versa — otherwise the number barely changes under rotation.
        const pairMostlyHorizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
        const edge = bEntry![1][0]!.edge;
        const measuresVertically = edge === "top" || edge === "bottom";
        expect(
          measuresVertically,
          `${layout.id}/${piece.id} rotation anchor measures to ${edge}`,
        ).toBe(pairMostlyHorizontal);
      }
    }
  });

  it("measures 180°-twin pieces alike (both card halves print the same numbers)", () => {
    expect(keystonePairingViolations(layouts, templates)).toEqual([]);
  });

  it("is a fixed point of the derivation (regenerating authors nothing new)", () => {
    const copy = JSON.parse(JSON.stringify(layouts)) as TerrainLayout[];
    expect(authorKeystones(copy, templates)).toBe(0);
  });
});
