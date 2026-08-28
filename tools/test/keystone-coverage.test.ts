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
import {
  BOARD_INCHES,
  keystoneMeasurements,
} from "../src/terrain/keystones.js";
import {
  authorKeystones,
  cardinalCornerIndices,
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
          (piece.keystones ?? []).map((k) =>
            k.ref.kind === "vertex" ? k.ref.index : -1,
          ),
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

  it("recognizes every detailed Battlemaster plate family independently", () => {
    const families = [
      ["bm-composite-bigrect-", [0, 182, 183, 184]],
      ["bm-composite-longline", [0, 173, 174, 256]],
      ["bm-composite-shortline-", [0, 82, 83, 165]],
      ["bm-composite-smallrect-", [0, 92, 93, 94]],
      ["bm-composite-triangle-ab-", [61, 62, 63, 345]],
    ] as const;
    for (const [prefix, expected] of families) {
      const matching = templates.filter((template) =>
        template.id.startsWith(prefix),
      );
      expect(matching.length, prefix).toBeGreaterThan(0);
      for (const template of matching) {
        expect(
          new Set(cardinalCornerIndices(template.footprint, template.id)),
          template.id,
        ).toEqual(new Set(expected));
      }
    }
  });

  it("anchors structural plate corners rather than decorative nubs", () => {
    const byTemplate = new Map(
      templates.map((template) => [template.id, template]),
    );
    for (const layout of bmLayouts) {
      for (const piece of layout.pieces ?? []) {
        const footprint =
          piece.footprint ??
          (piece.template
            ? byTemplate.get(piece.template)?.footprint
            : undefined);
        expect(footprint, `${layout.id}/${piece.id} footprint`).toBeDefined();
        const corners = new Set(
          cardinalCornerIndices(footprint!, piece.template),
        );
        for (const keystone of piece.keystones ?? []) {
          if (keystone.ref.kind !== "vertex") continue;
          expect(
            corners.has(keystone.ref.index),
            `${layout.id}/${piece.id} vertex ${keystone.ref.index}`,
          ).toBe(true);
        }
      }
    }
  });

  it("pins Take vs Take 01 area 14 to structural vertex 83", () => {
    const layout = bmLayouts.find(
      (candidate) => candidate.id === "bm-take-vs-take-01",
    )!;
    const piece = layout.pieces?.find(
      (candidate) => candidate.id === "area-14",
    )!;
    expect(
      piece.keystones?.map((keystone) =>
        keystone.ref.kind === "vertex" ? keystone.ref.index : -1,
      ),
    ).toEqual([83, 83]);
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
        expect(
          m.distance,
          `${layout.id}/${m.piece_id}/${m.edge}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          m.distance,
          `${layout.id}/${m.piece_id}/${m.edge}`,
        ).toBeLessThanOrEqual(extent);
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
        const aEntry = [...byAnchor.entries()].find(
          ([, ks]) => ks.length === 2,
        );
        const bEntry = [...byAnchor.entries()].find(
          ([, ks]) => ks.length === 1,
        );
        expect(aEntry, `${layout.id}/${piece.id} corner anchor`).toBeDefined();
        expect(
          bEntry,
          `${layout.id}/${piece.id} rotation anchor`,
        ).toBeDefined();
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
