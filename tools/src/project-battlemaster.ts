import { BSON } from "bson";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ComposedFeature,
  Footprint,
  LayoutPiece,
  Mirror,
  TerrainLayout,
  TerrainTemplate,
  Wall,
  Vec2,
} from "./terrain/resolve.js";
import {
  footprintVertices,
  polygonCentroid,
  resolveLayout,
} from "./terrain/resolve.js";
import { applyWrites } from "./mfm/apply.js";
import { CORE_DIR, readJsonArray } from "./mfm/repo-files.js";

export const BATTLEMASTER_SPAWNER_WORKSHOP_ID = "3781889191";
export const BATTLEMASTER_SPAWNER_PAGE = `https://steamcommunity.com/sharedfiles/filedetails/?id=${BATTLEMASTER_SPAWNER_WORKSHOP_ID}`;
export const BATTLEMASTER_PUBLIC_DATA_DOCS =
  "https://battlemaster.online/v1/public/docs#tag/data";
const WORKSHOP_DETAILS_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const CACHE_START = "-- BM_BAKED_CACHE_START";
const CACHE_END = "-- BM_BAKED_CACHE_END";
const SOURCE = "battlemaster-11e";
const GAME_VERSION = {
  edition: "11th",
  dataslate: "pre-launch-provisional",
} as const;
const BOARD = { width: 60, height: 44 } as const;
const ERROR_TOLERANCE = 1e-3;

const DEPLOYMENT_KEY_TO_PATTERN: Record<number, string> = {
  1: "search-and-destroy",
  2: "dawn-of-war",
  3: "hammer-and-anvil",
  4: "crucible-of-battle",
  5: "sweeping-engagement",
  6: "tipping-point",
};
const SIZE_CLASS_TO_AREA_TEMPLATE: Record<string, string> = {
  br: "area-large",
  tr: "area-trapezoid",
  sr: "area-medium",
  ll: "area-long-line",
  sl: "area-short-line",
};
const EXPECTED_COMPOSITE_DIMENSIONS: Record<
  string,
  { width: number; height: number }
> = {
  br: { width: 11.503, height: 7.003 },
  tr: { width: 11.503, height: 8.003 },
  sr: { width: 6.003, height: 4.003 },
  ll: { width: 10.003, height: 2.503 },
  sl: { width: 6.003, height: 2.003 },
};
const NUBBED_SIZE_CLASSES = new Set(["br", "sr", "ll", "sl"]);
const AREA_ORIENTATION_OFFSETS: Record<string, number> = {
  "area-large": 180,
  "area-trapezoid": 270,
  "area-medium": 0,
  "area-long-line": 0,
  "area-short-line": 180,
};
const OBJECTIVE_CODE_TO_ROLE: Record<string, "home" | "expansion" | "center"> =
  {
    c: "center",
    c1: "center",
    c2: "center",
    n: "expansion",
    hb: "home",
    hr: "home",
    hl: "home",
    ht: "home",
  };
const REQUIRED_CACHE_SECTIONS: Record<string, true> = {
  bakedAt: true,
  layoutCatalog: true,
  layoutPayloadCache: true,
  templateCatalog: true,
  version: true,
};

interface TtsSave {
  ObjectStates?: Array<{ Nickname?: string; LuaScript?: string }>;
}
interface LuaField {
  key: string | null;
  value: LuaValue;
}
type LuaValue = null | boolean | number | string | LuaField[];

interface LuaParser {
  readonly text: string;
  index: number;
}

interface RawPart {
  name: string;
  width: number;
  height: number;
}

interface RawTemplatePart {
  partIndex: number;
  x: number;
  y: number;
  rotation: number;
  mirror: number;
}

interface RawComposite {
  id: string;
  width: number;
  height: number;
  parts: RawTemplatePart[];
  sizeClass: string;
  style: string;
  label: string;
}

interface RawTemplateCatalog {
  id: string;
  units: string;
  anchor: string;
  parts: RawPart[];
  composites: RawComposite[];
}

interface RawLayoutInstance {
  templateIndex: number;
  x: number;
  y: number;
  rotation: number;
  mirror: number;
  objectiveCode: string | null;
}

interface RawLayout {
  battlemasterId: string;
  name: string;
  archetypeA: string;
  archetypeB: string;
  slot: number;
  deploymentKey: number;
  board: string;
  instances: RawLayoutInstance[];
}

interface ProjectedPiece extends LayoutPiece {
  objective_role?: "home" | "expansion" | "center";
  is_objective?: boolean;
  objective?: { position?: Vec2; control_range_inches?: number };
}

interface ProjectedLayout extends TerrainLayout {
  source: string;
  description: string;
  mission_matchup_id: string;
  variant: number;
  deployment_pattern_id: string;
  pieces: ProjectedPiece[];
  game_version: typeof GAME_VERSION;
}

interface ProjectedTemplate extends TerrainTemplate {
  source: string;
  game_version: typeof GAME_VERSION;
}

interface CompositeVariant {
  template: ProjectedTemplate;
  footprint: Footprint;
  targetWidth: number;
  targetHeight: number;
  anchorDelta: Vec2;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface BattlemasterProjectionSummary {
  source_kind: "rest-api" | "tts-workshop-save";
  workshop_id?: string;
  source_file?: string;
  baked_at?: string;
  cache_version?: number;
  catalog_id?: string;
  owner?: string;
  fetched_at?: string;
  layouts: number;
  layout_instances: number;
  feature_instances: number;
  feature_templates: number;
  composite_templates: number;
  resolved_pieces: number;
  worst_area_error_inches: number;
  worst_feature_error_inches: number;
}

export interface BattlemasterProjection {
  readonly: true;
  source: {
    kind: "rest-api" | "tabletop-simulator-workshop-save";
    workshop_id?: string;
    workshop_page?: string;
    public_data_docs: string;
    source_file?: string;
    baked_at?: string;
    cache_version?: number;
    catalog_id?: string;
    owner?: string;
    fetched_at?: string;
  };
  terrain_templates: ProjectedTemplate[];
  terrain_layouts: ProjectedLayout[];
  summary: BattlemasterProjectionSummary;
}

export interface ProjectBattlemasterOptions {
  inputPath?: string;
  owner?: string;
  fetch?: typeof globalThis.fetch;
}

function fail(message: string): never {
  throw new Error(`Battlemaster projector: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function binaryFlag(value: unknown, where: string): number {
  if (value === undefined) return 0;
  const flag = integer(value, where);
  if (flag !== 0 && flag !== 1) fail(`${where}: expected binary 0 or 1`);
  return flag;
}

function expectInteger(
  value: unknown,
  expected: number,
  where: string,
): number {
  const actual = integer(value, where);
  if (actual !== expected)
    fail(`${where}: expected ${expected}, got ${actual}`);
  return actual;
}

function expectString(value: unknown, expected: string, where: string): string {
  const actual = string(value, where);
  if (actual !== expected) {
    fail(
      `${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  return actual;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where}: expected an array`);
  return value;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${where}: expected a non-empty string`);
  return value;
}

function number(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${where}: expected a finite number`);
  return value;
}

function integer(value: unknown, where: string): number {
  const n = number(value, where);
  if (!Number.isInteger(n)) fail(`${where}: expected an integer`);
  return n;
}

function optionalString(value: unknown, where: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return string(value, where);
}

function tupleValue(tuple: unknown, index: number): unknown {
  if (Array.isArray(tuple)) return tuple[index];
  return record(tuple, "tuple")[String(index + 1)];
}

function tupleArray(value: unknown, where: string): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = record(value, where);
  const keys = Object.keys(obj);
  if (!keys.every((key) => /^\d+$/.test(key)))
    fail(`${where}: expected a positional array`);
  const ordered = keys.map(Number).sort((a, b) => a - b);
  if (!ordered.every((key, index) => key === index + 1))
    fail(`${where}: sparse positional array`);
  return ordered.map((key) => obj[String(key)]);
}

function norm360(degrees: number): number {
  const value = degrees % 360;
  return value < 0 ? value + 360 : value;
}

function round6(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toBoardFrame(x: number, y: number): Vec2 {
  return { x: round6(x + BOARD.width / 2), y: round6(BOARD.height / 2 - y) };
}

function slug(value: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!out) fail(`cannot form an id from ${JSON.stringify(value)}`);
  return out;
}

function layoutId(raw: RawLayout): string {
  if (raw.archetypeA === raw.archetypeB && raw.archetypeA === "take-and-hold") {
    return `take-and-hold-mirror-${raw.slot}`;
  }
  return `${raw.archetypeA}-vs-${raw.archetypeB}-${raw.slot}`;
}

function matchupId(raw: RawLayout): string {
  return `${raw.archetypeA}-vs-${raw.archetypeB}`;
}

function rotateCcwYUp(point: Vec2, degrees: number): Vec2 {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: cosine * point.x - sine * point.y,
    y: sine * point.x + cosine * point.y,
  };
}

function partCentreYUp(part: RawPart, placed: RawTemplatePart): Vec2 {
  const corners: Vec2[] = [
    { x: 0, y: 0 },
    { x: part.width, y: 0 },
    { x: part.width, y: part.height },
    { x: 0, y: part.height },
  ]
    .map((point) => ({ x: placed.mirror ? -point.x : point.x, y: point.y }))
    .map((point) => rotateCcwYUp(point, placed.rotation))
    .map((point) => ({ x: point.x + placed.x, y: point.y + placed.y }));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function orient(point: Vec2, rotation: number, mirror: Mirror): Vec2 {
  if (mirror === "horizontal") {
    return rotateCcwYUp({ x: -point.x, y: point.y }, rotation);
  }
  if (mirror === "vertical") {
    return rotateCcwYUp({ x: point.x, y: -point.y }, rotation);
  }
  return rotateCcwYUp(point, rotation);
}

function boundsOf(points: Vec2[]): Bounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function clippedArea(
  polygon: Vec2[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let output = polygon;
  const edges: Array<[(point: Vec2) => boolean, (a: Vec2, b: Vec2) => Vec2]> = [
    [
      (point) => point.x >= x0,
      (a, b) => ({ x: x0, y: a.y + ((b.y - a.y) * (x0 - a.x)) / (b.x - a.x) }),
    ],
    [
      (point) => point.x <= x1,
      (a, b) => ({ x: x1, y: a.y + ((b.y - a.y) * (x1 - a.x)) / (b.x - a.x) }),
    ],
    [
      (point) => point.y >= y0,
      (a, b) => ({ x: a.x + ((b.x - a.x) * (y0 - a.y)) / (b.y - a.y), y: y0 }),
    ],
    [
      (point) => point.y <= y1,
      (a, b) => ({ x: a.x + ((b.x - a.x) * (y1 - a.y)) / (b.y - a.y), y: y1 }),
    ],
  ];
  for (const [keep, intersect] of edges) {
    const next: Vec2[] = [];
    for (let index = 0; index < output.length; index += 1) {
      const a = output[index]!;
      const b = output[(index + 1) % output.length]!;
      const keepA = keep(a);
      const keepB = keep(b);
      if (keepA) next.push(a);
      if (keepA !== keepB) next.push(intersect(a, b));
    }
    output = next;
    if (output.length === 0) return 0;
  }
  let twiceArea = 0;
  for (let index = 0; index < output.length; index += 1) {
    const a = output[index]!;
    const b = output[(index + 1) % output.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twiceArea) / 2;
}

function artworkBoxCentre(
  footprint: Footprint,
  targetWidth: number,
  targetHeight: number,
): Vec2 {
  const vertices = footprintVertices(footprint);
  const bounds = boundsOf(vertices);
  const slackX = Math.max(0, bounds.maxX - bounds.minX - targetWidth);
  const slackY = Math.max(0, bounds.maxY - bounds.minY - targetHeight);
  const search = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    steps: number,
  ): { area: number; x: number; y: number } => {
    let best = { area: -1, x: x0, y: y0 };
    const nx = x1 - x0 < 1e-9 ? 0 : steps;
    const ny = y1 - y0 < 1e-9 ? 0 : steps;
    for (let xIndex = 0; xIndex <= nx; xIndex += 1) {
      const x = nx === 0 ? x0 : x0 + ((x1 - x0) * xIndex) / nx;
      for (let yIndex = 0; yIndex <= ny; yIndex += 1) {
        const y = ny === 0 ? y0 : y0 + ((y1 - y0) * yIndex) / ny;
        const area = clippedArea(
          vertices,
          x,
          y,
          x + targetWidth,
          y + targetHeight,
        );
        if (area > best.area + 1e-9) best = { area, x, y };
      }
    }
    return best;
  };
  const steps = 40;
  const coarse = search(
    bounds.minX,
    bounds.minX + slackX,
    bounds.minY,
    bounds.minY + slackY,
    steps,
  );
  const cellX = slackX / steps;
  const cellY = slackY / steps;
  const fine = search(
    Math.max(bounds.minX, coarse.x - cellX),
    Math.min(bounds.minX + slackX, coarse.x + cellX),
    Math.max(bounds.minY, coarse.y - cellY),
    Math.min(bounds.minY + slackY, coarse.y + cellY),
    steps,
  );
  const best = fine.area >= coarse.area ? fine : coarse;
  return { x: best.x + targetWidth / 2, y: best.y + targetHeight / 2 };
}

function transformFootprint(
  footprint: Footprint,
  transform: (point: Vec2, bounds: Bounds) => Vec2,
): Footprint {
  const vertices = footprintVertices(footprint);
  const bounds = boundsOf(vertices);
  return {
    type: "polygon",
    points: vertices.map((point) => {
      const transformed = transform(point, bounds);
      return { x: round6(transformed.x), y: round6(transformed.y) };
    }),
  };
}

function mirrorFootprint(footprint: Footprint): Footprint {
  return transformFootprint(footprint, (point, bounds) => ({
    x: bounds.minX + bounds.maxX - point.x,
    y: point.y,
  }));
}

function halfTurnFootprint(footprint: Footprint): Footprint {
  return transformFootprint(footprint, (point, bounds) => ({
    x: bounds.minX + bounds.maxX - point.x,
    y: bounds.minY + bounds.maxY - point.y,
  }));
}

function anchorDelta(
  footprint: Footprint,
  targetWidth: number,
  targetHeight: number,
): Vec2 {
  const centre = artworkBoxCentre(footprint, targetWidth, targetHeight);
  const centroid = polygonCentroid(footprintVertices(footprint));
  return { x: centre.x - centroid.x, y: centre.y - centroid.y };
}

function partPositionInArea(
  catalog: RawTemplateCatalog,
  composite: RawComposite,
  partIndex: number,
  offset: number,
  delta: Vec2,
  areaMirrored: boolean,
): Vec2 {
  const placed = composite.parts[partIndex]!;
  const part = catalog.parts[placed.partIndex]!;
  const centre = partCentreYUp(part, placed);
  const rotated = rotateCcwYUp(
    { x: centre.x, y: -centre.y },
    areaMirrored ? offset : -offset,
  );
  return { x: rotated.x + delta.x, y: rotated.y + delta.y };
}

function partRotation(
  composite: RawComposite,
  partIndex: number,
  offset: number,
  areaMirrored: boolean,
): number {
  const rotation = composite.parts[partIndex]!.rotation;
  return norm360(areaMirrored ? -rotation + offset : -rotation - offset);
}

function placedFootprint(
  footprint: Footprint,
  position: Vec2,
  rotation: number,
  mirror: Mirror,
): Vec2[] {
  const centroid = polygonCentroid(footprintVertices(footprint));
  return footprintVertices(footprint).map((point) => {
    const placed = orient(
      { x: point.x - centroid.x, y: point.y - centroid.y },
      rotation,
      mirror,
    );
    return { x: placed.x + position.x, y: placed.y + position.y };
  });
}

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++
  ) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceOutside(point: Vec2, polygon: Vec2[]): number {
  if (pointInPolygon(point, polygon)) return 0;
  let best = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const along =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
            ),
          );
    best = Math.min(
      best,
      Math.hypot(point.x - (a.x + along * dx), point.y - (a.y + along * dy)),
    );
  }
  return best <= 0.05 ? 0 : best;
}


function chooseFootprint(
  catalog: RawTemplateCatalog,
  composite: RawComposite,
  candidates: Footprint[],
  offset: number,
  targetWidth: number,
  targetHeight: number,
  areaMirrored: boolean,
): number {
  const score = (footprint: Footprint): number => {
    const delta = anchorDelta(footprint, targetWidth, targetHeight);
    const parent = placedFootprint(footprint, { x: 0, y: 0 }, 0, "none");
    let outside = 0;
    for (let index = 0; index < composite.parts.length; index += 1) {
      const placed = composite.parts[index]!;
      const part = catalog.parts[placed.partIndex]!;
      const position = partPositionInArea(
        catalog,
        composite,
        index,
        offset,
        delta,
        areaMirrored,
      );
      const rotation = partRotation(composite, index, offset, areaMirrored);
      const child: Footprint = {
        type: "rectangle",
        width: part.width,
        height: part.height,
      };
      for (const point of placedFootprint(
        child,
        position,
        rotation,
        placed.mirror ? "horizontal" : "none",
      )) {
        outside += distanceOutside(point, parent);
      }
    }
    return outside;
  };
  // Candidate order is the source contract: the authored pose, its mirror,
  // then their half-turns. Equal fits retain the earliest authored pose.
  let bestIndex = 0;
  let bestScore = score(candidates[0]!);
  for (let index = 1; index < candidates.length; index += 1) {
    const candidateScore = score(candidates[index]!);
    if (candidateScore < bestScore - 1e-9) {
      bestIndex = index;
      bestScore = candidateScore;
    }
  }
  if (bestScore > 1e-9) {
    fail(
      `${composite.id}: no canonical area pose contains its source features ` +
        `(best outside-distance score ${bestScore.toFixed(6)})`,
    );
  }
  return bestIndex;
}

function skipSpace(parser: LuaParser): void {
  while (/\s/.test(parser.text[parser.index] ?? "")) parser.index += 1;
}

function parseLuaString(parser: LuaParser): string {
  const quote = parser.text[parser.index];
  if (quote !== '"' && quote !== "'")
    fail(`Lua offset ${parser.index}: expected a string`);
  parser.index += 1;
  let output = "";
  while (parser.index < parser.text.length) {
    const char = parser.text[parser.index++];
    if (char === quote) return output;
    if (char !== "\\") {
      output += char;
      continue;
    }
    const escaped = parser.text[parser.index++];
    const simple: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"',
      "'": "'",
    };
    if (escaped in simple) {
      output += simple[escaped]!;
    } else if (escaped === "z") {
      skipSpace(parser);
    } else if (/\d/.test(escaped ?? "")) {
      let digits = escaped!;
      while (digits.length < 3 && /\d/.test(parser.text[parser.index] ?? "")) {
        digits += parser.text[parser.index++];
      }
      output += String.fromCharCode(Number(digits));
    } else {
      output += escaped ?? "";
    }
  }
  fail("unterminated Lua string");
}

function parseLuaIdentifier(parser: LuaParser): string {
  const start = parser.index;
  while (/[A-Za-z0-9_]/.test(parser.text[parser.index] ?? ""))
    parser.index += 1;
  if (parser.index === start)
    fail(`Lua offset ${parser.index}: expected an identifier`);
  return parser.text.slice(start, parser.index);
}

function parseLuaNumber(parser: LuaParser): number {
  const match = parser.text
    .slice(parser.index)
    .match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
  if (!match) fail(`Lua offset ${parser.index}: expected a number`);
  parser.index += match[0].length;
  return Number(match[0]);
}

function parseLuaTable(parser: LuaParser): LuaField[] {
  parser.index += 1;
  const fields: LuaField[] = [];
  while (true) {
    skipSpace(parser);
    if (parser.text[parser.index] === "}") {
      parser.index += 1;
      return fields;
    }
    let key: string | null = null;
    if (parser.text[parser.index] === "[") {
      parser.index += 1;
      skipSpace(parser);
      key = String(parseLuaValue(parser));
      skipSpace(parser);
      if (parser.text[parser.index++] !== "]")
        fail(`Lua offset ${parser.index}: expected ]`);
      skipSpace(parser);
      if (parser.text[parser.index++] !== "=")
        fail(`Lua offset ${parser.index}: expected =`);
    } else {
      const saved = parser.index;
      if (/[A-Za-z_]/.test(parser.text[parser.index] ?? "")) {
        const candidate = parseLuaIdentifier(parser);
        skipSpace(parser);
        if (parser.text[parser.index] === "=") {
          key = candidate;
          parser.index += 1;
        } else {
          parser.index = saved;
        }
      }
    }
    skipSpace(parser);
    fields.push({ key, value: parseLuaValue(parser) });
    skipSpace(parser);
    if (parser.text[parser.index] === "," || parser.text[parser.index] === ";")
      parser.index += 1;
  }
}

function parseLuaValue(parser: LuaParser): LuaValue {
  skipSpace(parser);
  const char = parser.text[parser.index];
  if (char === "{") return parseLuaTable(parser);
  if (char === '"' || char === "'") return parseLuaString(parser);
  if (char === "-" || /\d/.test(char ?? "")) return parseLuaNumber(parser);
  const identifier = parseLuaIdentifier(parser);
  if (identifier === "true") return true;
  if (identifier === "false") return false;
  if (identifier === "nil") return null;
  fail(`Lua offset ${parser.index}: unsupported value ${identifier}`);
}

function luaToJs(value: LuaValue): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 0) return {};
  const hasNamed = value.some((field) => field.key !== null);
  if (!hasNamed) return value.map((field) => luaToJs(field.value));
  const output: Record<string, unknown> = {};
  let implicit = 1;
  for (const field of value) {
    output[field.key ?? String(implicit++)] = luaToJs(field.value);
  }
  const keys = Object.keys(output);
  if (keys.every((key) => /^\d+$/.test(key))) {
    const ordered = keys.map(Number).sort((a, b) => a - b);
    if (ordered.every((key, index) => key === index + 1)) {
      return ordered.map((key) => output[String(key)]);
    }
  }
  return output;
}

export function decodeBakedCache(luaScript: string): Record<string, unknown> {
  const start = luaScript.indexOf(CACHE_START);
  const end = luaScript.indexOf(CACHE_END);
  if (start < 0 || end <= start)
    fail("the object has no complete BM_BAKED_CACHE block");
  const body = luaScript.slice(start + CACHE_START.length, end);
  const cache: Record<string, unknown> = {};
  for (const statement of body.split(/\r?\n/)) {
    const line = statement.trim();
    if (!line || line === "BM_BAKED_CACHE={}") continue;
    const match = line.match(
      /^BM_BAKED_CACHE\["((?:[^"\\]|\\.)+)"\](?:\["((?:[^"\\]|\\.)+)"\])?=(.*)$/,
    );
    const sectionMatch = line.match(/^BM_BAKED_CACHE\["((?:[^"\\]|\\.)+)"\]/);
    if (!sectionMatch)
      fail(`unsupported baked-cache statement: ${line.slice(0, 80)}`);
    const decodeKey = (raw: string): string =>
      parseLuaString({ text: `"${raw}"`, index: 0 });
    const section = decodeKey(sectionMatch[1]!);
    if (!REQUIRED_CACHE_SECTIONS[section]) continue;
    if (!match) fail(`unsupported ${section} statement: ${line.slice(0, 80)}`);
    const nested = match[2] === undefined ? null : decodeKey(match[2]);
    const parser: LuaParser = { text: match[3]!, index: 0 };
    const decoded = luaToJs(parseLuaValue(parser));
    skipSpace(parser);
    if (parser.index !== parser.text.length)
      fail(`trailing Lua data in ${section}`);
    if (nested === null) {
      cache[section] = decoded;
    } else {
      const target = cache[section];
      if (
        typeof target !== "object" ||
        target === null ||
        Array.isArray(target)
      ) {
        fail(`${section}: nested assignment before table declaration`);
      }
      (target as Record<string, unknown>)[nested] = decoded;
    }
  }
  return cache;
}

function findSpawnerScript(save: TtsSave): string {
  const objects = save.ObjectStates ?? [];
  const candidates = objects.filter((object) =>
    object.LuaScript?.includes(CACHE_START),
  );
  if (candidates.length !== 1) {
    fail(
      `expected exactly one object with a baked cache, found ${candidates.length}`,
    );
  }
  return candidates[0]!.LuaScript!;
}
export function decodeSpawnerSave(bytes: Uint8Array): Record<string, unknown> {
  let save: TtsSave;
  try {
    save = BSON.deserialize(bytes) as TtsSave;
  } catch (error) {
    fail(
      `cannot decode the Tabletop Simulator BSON save: ${(error as Error).message}`,
    );
  }
  return decodeBakedCache(findSpawnerScript(save));
}

function decodeTemplateCatalog(rawValue: unknown): RawTemplateCatalog {
  const raw = record(rawValue, "templateCatalog");
  expectInteger(raw.v, 1, "templateCatalog.v");
  expectString(raw.k, "bmtc", "templateCatalog.k");
  const units = string(raw.u, "templateCatalog.u");
  const anchor = string(raw.a, "templateCatalog.a");
  if (units !== "in")
    fail(`templateCatalog.u: expected "in", got ${JSON.stringify(units)}`);
  if (anchor !== "c")
    fail(
      `templateCatalog.a: expected centre anchor "c", got ${JSON.stringify(anchor)}`,
    );
  const parts = tupleArray(raw.q, "templateCatalog.q").map(
    (value, index): RawPart => {
      const tuple = tupleArray(value, `templateCatalog.q[${index}]`);
      return {
        name: string(tuple[0], `templateCatalog.q[${index}][0]`),
        width: number(tuple[1], `templateCatalog.q[${index}][1]`),
        height: number(tuple[2], `templateCatalog.q[${index}][2]`),
      };
    },
  );
  const composites = tupleArray(raw.t, "templateCatalog.t").map(
    (value, index): RawComposite => {
      const tuple = tupleArray(value, `templateCatalog.t[${index}]`);
      const placed = tupleArray(tuple[3], `templateCatalog.t[${index}][3]`).map(
        (partValue, partIndex) => {
          const part = tupleArray(
            partValue,
            `templateCatalog.t[${index}][3][${partIndex}]`,
          );
          const sourceIndex = integer(
            part[0],
            `templateCatalog.t[${index}][3][${partIndex}][0]`,
          );
          if (sourceIndex < 0 || sourceIndex >= parts.length) {
            fail(
              `templateCatalog.t[${index}][3][${partIndex}]: part index ${sourceIndex} is out of range`,
            );
          }
          return {
            partIndex: sourceIndex,
            x: number(
              part[1],
              `templateCatalog.t[${index}][3][${partIndex}][1]`,
            ),
            y: number(
              part[2],
              `templateCatalog.t[${index}][3][${partIndex}][2]`,
            ),
            rotation: number(
              part[3],
              `templateCatalog.t[${index}][3][${partIndex}][3]`,
            ),
            mirror: binaryFlag(
              part[4],
              `templateCatalog.t[${index}][3][${partIndex}][4]`,
            ),
          };
        },
      );
      return {
        id: string(tuple[0], `templateCatalog.t[${index}][0]`),
        width: number(tuple[1], `templateCatalog.t[${index}][1]`),
        height: number(tuple[2], `templateCatalog.t[${index}][2]`),
        parts: placed,
        sizeClass: string(tuple[4], `templateCatalog.t[${index}][4]`),
        style:
          optionalString(tuple[5], `templateCatalog.t[${index}][5]`) ?? "",
        label:
          optionalString(tuple[6], `templateCatalog.t[${index}][6]`) ?? "",
      };
    },
  );
  return {
    id: string(raw.id, "templateCatalog.id"),
    units,
    anchor,
    parts,
    composites,
  };
}

function decodeLayouts(
  cache: Record<string, unknown>,
  templateCount: number,
): RawLayout[] {
  const catalog = record(cache.layoutCatalog, "layoutCatalog");
  const catalogRows = array(catalog.layouts, "layoutCatalog.layouts");
  const chapterRows = catalogRows.filter((value) => {
    const row = record(value, "layoutCatalog.layouts[]");
    return (
      row.missionPackId === "chapter-approved-2026" &&
      row.chapterApprovedSlot !== undefined
    );
  });
  const byId = new Map(
    chapterRows.map((value) => {
      const row = record(value, "layoutCatalog.layouts[]");
      return [string(row.id, "layoutCatalog.layouts[].id"), row] as const;
    }),
  );
  const payloads = record(cache.layoutPayloadCache, "layoutPayloadCache");
  const decoded: RawLayout[] = [];
  for (const value of Object.values(payloads)) {
    const entry = record(value, "layoutPayloadCache[]");
    const payload = record(entry.payload, "layoutPayloadCache[].payload");
    expectInteger(payload.v, 1, "layoutPayloadCache[].payload.v");
    expectString(payload.k, "bml", "layoutPayloadCache[].payload.k");
    const battlemasterId = string(
      payload.id,
      "layoutPayloadCache[].payload.id",
    );
    const meta = byId.get(battlemasterId);
    if (!meta) continue;
    const slot = record(
      meta.chapterApprovedSlot,
      `${battlemasterId}.chapterApprovedSlot`,
    );
    const board = string(payload.b, `${battlemasterId}.payload.b`);
    if (board !== "sf60x44")
      fail(`${battlemasterId}: unsupported board ${JSON.stringify(board)}`);
    if (payload.a !== "c")
      fail(`${battlemasterId}: expected centre anchor "c"`);
    const instances = tupleArray(payload.i, `${battlemasterId}.payload.i`).map(
      (instanceValue, index) => {
        const instance = tupleArray(
          instanceValue,
          `${battlemasterId}.payload.i[${index}]`,
        );
        const templateIndex = integer(
          instance[0],
          `${battlemasterId}.payload.i[${index}][0]`,
        );
        if (templateIndex < 0 || templateIndex >= templateCount) {
          fail(
            `${battlemasterId}.payload.i[${index}]: template index ${templateIndex} is out of range`,
          );
        }
        return {
          templateIndex,
          x: number(instance[1], `${battlemasterId}.payload.i[${index}][1]`),
          y: number(instance[2], `${battlemasterId}.payload.i[${index}][2]`),
          rotation: number(
            instance[3],
            `${battlemasterId}.payload.i[${index}][3]`,
          ),
          mirror: binaryFlag(
            instance[4],
            `${battlemasterId}.payload.i[${index}][4]`,
          ),
          objectiveCode: optionalString(
            instance[5],
            `${battlemasterId}.payload.i[${index}][5]`,
          ),
        };
      },
    );
    decoded.push({
      battlemasterId,
      name: string(meta.name, `${battlemasterId}.name`),
      archetypeA: string(
        slot.archetypeA,
        `${battlemasterId}.chapterApprovedSlot.archetypeA`,
      ),
      archetypeB: string(
        slot.archetypeB,
        `${battlemasterId}.chapterApprovedSlot.archetypeB`,
      ),
      slot: integer(
        slot.slotIndex,
        `${battlemasterId}.chapterApprovedSlot.slotIndex`,
      ),
      deploymentKey: integer(
        meta.chapterApprovedDeploymentKey,
        `${battlemasterId}.chapterApprovedDeploymentKey`,
      ),
      board,
      instances,
    });
  }
  decoded.sort((a, b) => layoutId(a).localeCompare(layoutId(b)));
  if (decoded.length !== chapterRows.length) {
    fail(
      `layout payload coverage: ${decoded.length} payloads for ${chapterRows.length} Chapter Approved layouts`,
    );
  }
  return decoded;
}

function partTemplateId(
  catalog: RawTemplateCatalog,
  partIndex: number,
): string {
  return `bm-${slug(catalog.id)}-part-${slug(catalog.parts[partIndex]!.name)}`;
}

function compositeTemplateId(
  catalog: RawTemplateCatalog,
  index: number,
): string {
  return `bm-${slug(catalog.id)}-composite-${String(index + 1).padStart(2, "0")}`;
}
function validateAreaContracts(
  catalog: RawTemplateCatalog,
  canonicalById: Map<string, TerrainTemplate>,
): void {
  for (const composite of catalog.composites) {
    const expected = EXPECTED_COMPOSITE_DIMENSIONS[composite.sizeClass];
    if (!expected)
      fail(`unknown area size class ${JSON.stringify(composite.sizeClass)}`);
    if (
      Math.abs(composite.width - expected.width) > ERROR_TOLERANCE ||
      Math.abs(composite.height - expected.height) > ERROR_TOLERANCE
    ) {
      fail(
        `${composite.id}: ${composite.sizeClass} dimensions changed from ` +
          `${expected.width}x${expected.height} to ${composite.width}x${composite.height}`,
      );
    }
    const areaTemplateId = SIZE_CLASS_TO_AREA_TEMPLATE[composite.sizeClass]!;
    const canonical = canonicalById.get(areaTemplateId);
    if (!canonical)
      fail(
        `missing canonical terrain template ${JSON.stringify(areaTemplateId)}`,
      );
    if (
      NUBBED_SIZE_CLASSES.has(composite.sizeClass) &&
      (canonical.footprint.type !== "polygon" ||
        canonical.footprint.points.length <= 4)
    ) {
      fail(
        `${areaTemplateId}: expected the canonical nubbed polygon footprint`,
      );
    }
  }
}

interface ProjectedGeometry {
  templates: ProjectedTemplate[];
  layouts: ProjectedLayout[];
  variants: Map<string, CompositeVariant>;
}

function projectGeometry(
  catalog: RawTemplateCatalog,
  rawLayouts: RawLayout[],
  canonicalTemplates: TerrainTemplate[],
): ProjectedGeometry {
  const canonicalById = new Map(
    canonicalTemplates.map((template) => [template.id, template]),
  );
  validateAreaContracts(catalog, canonicalById);
  const featureTemplates: ProjectedTemplate[] = catalog.parts.map(
    (part, index) => ({
      id: partTemplateId(catalog, index),
      name: `Battlemaster ${part.name}`,
      kind: "feature",
      source: SOURCE,
      footprint: { type: "rectangle", width: part.width, height: part.height },
      game_version: GAME_VERSION,
    }),
  );
  const variants = new Map<string, CompositeVariant>();
  const variantsBySourceKey = new Map<string, CompositeVariant>();

  const layouts = rawLayouts.map((raw): ProjectedLayout => {
    const deployment = DEPLOYMENT_KEY_TO_PATTERN[raw.deploymentKey];
    if (!deployment)
      fail(
        `${raw.battlemasterId}: unknown deployment key ${raw.deploymentKey}`,
      );
    const pieces = raw.instances.map((instance, index): ProjectedPiece => {
      const composite = catalog.composites[instance.templateIndex]!;
      const areaTemplateId = SIZE_CLASS_TO_AREA_TEMPLATE[composite.sizeClass];
      if (!areaTemplateId)
        fail(`unknown area size class ${JSON.stringify(composite.sizeClass)}`);
      const offset = AREA_ORIENTATION_OFFSETS[areaTemplateId];
      if (offset === undefined)
        fail(
          `missing orientation offset for ${JSON.stringify(areaTemplateId)}`,
        );
      const areaMirrored = instance.mirror !== 0;
      const sourceVariantKey = `${instance.templateIndex}-m${Number(areaMirrored)}`;
      let variant = variantsBySourceKey.get(sourceVariantKey);
      if (!variant) {
        const canonical = canonicalById.get(areaTemplateId);
        if (!canonical)
          fail(
            `missing canonical terrain template ${JSON.stringify(areaTemplateId)}`,
          );
        const targetWidth =
          offset % 180 === 0 ? composite.width : composite.height;
        const targetHeight =
          offset % 180 === 0 ? composite.height : composite.width;
        const candidates = [
          canonical.footprint,
          mirrorFootprint(canonical.footprint),
          halfTurnFootprint(canonical.footprint),
          mirrorFootprint(halfTurnFootprint(canonical.footprint)),
        ];
        const pose = chooseFootprint(
          catalog,
          composite,
          candidates,
          offset,
          targetWidth,
          targetHeight,
          areaMirrored,
        );
        const footprint = candidates[pose]!;
        const delta = anchorDelta(footprint, targetWidth, targetHeight);
        const template: ProjectedTemplate = {
          id: `${compositeTemplateId(catalog, instance.templateIndex)}-m${Number(areaMirrored)}-p${pose}`,
          name: `Battlemaster ${composite.sizeClass.toUpperCase()} ${String(instance.templateIndex + 1).padStart(2, "0")}`,
          kind: "area",
          source: SOURCE,
          footprint,
          features: composite.parts.map(
            (placed, partIndex): ComposedFeature => {
              const position = partPositionInArea(
                catalog,
                composite,
                partIndex,
                offset,
                delta,
                areaMirrored,
              );
              const feature: ComposedFeature = {
                id: `feature-${partIndex + 1}`,
                template: partTemplateId(catalog, placed.partIndex),
                position: { x: round6(position.x), y: round6(position.y) },
              };
              const rotation = partRotation(
                composite,
                partIndex,
                offset,
                areaMirrored,
              );
              if (rotation !== 0) feature.rotation_degrees = rotation;
              if (placed.mirror) feature.mirror = "horizontal";
              return feature;
            },
          ),
          game_version: GAME_VERSION,
        };
        variant = {
          template,
          footprint,
          targetWidth,
          targetHeight,
          anchorDelta: delta,
        };
        variants.set(template.id, variant);
        variantsBySourceKey.set(sourceVariantKey, variant);
      }

      const id = `area-${String(index + 1).padStart(2, "0")}`;
      const rotation = norm360(-instance.rotation + offset);
      const mirror: Mirror = areaMirrored ? "horizontal" : "none";
      const sourcePosition = toBoardFrame(instance.x, instance.y);
      const carried = orient(variant.anchorDelta, rotation, mirror);
      const piece: ProjectedPiece = {
        id,
        name: `Battlemaster area ${String(index + 1).padStart(2, "0")}`,
        piece_type: "area",
        template: variant.template.id,
        position: {
          x: round6(sourcePosition.x - carried.x),
          y: round6(sourcePosition.y - carried.y),
        },
      };
      if (rotation !== 0) piece.rotation_degrees = rotation;
      if (areaMirrored) piece.mirror = "horizontal";
      if (instance.objectiveCode) {
        const role = OBJECTIVE_CODE_TO_ROLE[instance.objectiveCode];
        if (!role)
          fail(
            `${raw.battlemasterId}/${id}: unknown objective code ${instance.objectiveCode}`,
          );
        piece.objective_role = role;
        piece.is_objective = true;
        if (
          instance.objectiveCode === "c1" ||
          instance.objectiveCode === "c2"
        ) {
          piece.link_group = "center";
        }
      }
      return piece;
    });
    return {
      id: layoutId(raw),
      name: raw.name,
      source: SOURCE,
      description: `Imported from Battlemaster layout ${raw.battlemasterId}.`,
      mission_matchup_id: matchupId(raw),
      variant: raw.slot,
      deployment_pattern_id: deployment,
      pieces,
      game_version: GAME_VERSION,
    };
  });

  return {
    templates: [
      ...featureTemplates,
      ...[...variants.values()].map((variant) => variant.template),
    ],
    layouts,
    variants,
  };
}

function placedSourceArea(
  composite: RawComposite,
  instance: RawLayoutInstance,
): Vec2[] {
  const local: Vec2[] = [
    { x: -composite.width / 2, y: -composite.height / 2 },
    { x: composite.width / 2, y: -composite.height / 2 },
    { x: composite.width / 2, y: composite.height / 2 },
    { x: -composite.width / 2, y: composite.height / 2 },
  ];
  return local.map((point) => {
    const mirrored = { x: instance.mirror ? -point.x : point.x, y: point.y };
    const rotated = rotateCcwYUp(mirrored, instance.rotation);
    return toBoardFrame(rotated.x + instance.x, rotated.y + instance.y);
  });
}

function placedSourcePart(
  catalog: RawTemplateCatalog,
  composite: RawComposite,
  partIndex: number,
  instance: RawLayoutInstance,
): Vec2[] {
  const placed = composite.parts[partIndex]!;
  const part = catalog.parts[placed.partIndex]!;
  const local: Vec2[] = [
    { x: 0, y: 0 },
    { x: part.width, y: 0 },
    { x: part.width, y: part.height },
    { x: 0, y: part.height },
  ];
  return local
    .map((point) => ({ x: placed.mirror ? -point.x : point.x, y: point.y }))
    .map((point) => rotateCcwYUp(point, placed.rotation))
    .map((point) => ({ x: point.x + placed.x, y: point.y + placed.y }))
    .map((point) => ({ x: instance.mirror ? -point.x : point.x, y: point.y }))
    .map((point) => rotateCcwYUp(point, instance.rotation))
    .map((point) => toBoardFrame(point.x + instance.x, point.y + instance.y));
}

function pointSetError(actual: Vec2[], expected: Vec2[]): number {
  const directed = (from: Vec2[], to: Vec2[]): number =>
    Math.max(
      ...from.map((point) =>
        Math.min(
          ...to.map((candidate) =>
            Math.hypot(point.x - candidate.x, point.y - candidate.y),
          ),
        ),
      ),
    );
  return Math.max(directed(actual, expected), directed(expected, actual));
}
function placedArtworkArea(
  piece: ProjectedPiece,
  variant: CompositeVariant,
): Vec2[] {
  const halfWidth = variant.targetWidth / 2;
  const halfHeight = variant.targetHeight / 2;
  const local = [
    {
      x: variant.anchorDelta.x - halfWidth,
      y: variant.anchorDelta.y - halfHeight,
    },
    {
      x: variant.anchorDelta.x + halfWidth,
      y: variant.anchorDelta.y - halfHeight,
    },
    {
      x: variant.anchorDelta.x + halfWidth,
      y: variant.anchorDelta.y + halfHeight,
    },
    {
      x: variant.anchorDelta.x - halfWidth,
      y: variant.anchorDelta.y + halfHeight,
    },
  ];
  const rotation = piece.rotation_degrees ?? 0;
  const mirror = piece.mirror ?? "none";
  return local.map((point) => {
    const transformed = orient(point, rotation, mirror);
    return {
      x: transformed.x + piece.position.x,
      y: transformed.y + piece.position.y,
    };
  });
}

function verifyProjection(
  catalog: RawTemplateCatalog,
  rawLayouts: RawLayout[],
  geometry: ProjectedGeometry,
): Pick<
  BattlemasterProjectionSummary,
  "resolved_pieces" | "worst_area_error_inches" | "worst_feature_error_inches"
> {
  let resolvedPieces = 0;
  let worstArea = 0;
  let worstFeature = 0;
  for (let layoutIndex = 0; layoutIndex < rawLayouts.length; layoutIndex += 1) {
    const raw = rawLayouts[layoutIndex]!;
    const layout = geometry.layouts[layoutIndex]!;
    const resolved = resolveLayout(layout, geometry.templates);
    resolvedPieces += resolved.length;
    let cursor = 0;
    for (
      let instanceIndex = 0;
      instanceIndex < raw.instances.length;
      instanceIndex += 1
    ) {
      const instance = raw.instances[instanceIndex]!;
      const composite = catalog.composites[instance.templateIndex]!;
      const piece = layout.pieces[instanceIndex]!;
      const variant = piece.template
        ? geometry.variants.get(piece.template)
        : undefined;
      if (!variant)
        fail(
          `${layout.id}/${piece.id}: projected composite variant is missing`,
        );
      const artworkError = pointSetError(
        placedArtworkArea(piece, variant),
        placedSourceArea(composite, instance),
      );
      const resolvedArea = resolved[cursor++]!;
      const footprintError = pointSetError(
        resolvedArea.vertices,
        placedFootprint(
          variant.footprint,
          piece.position,
          piece.rotation_degrees ?? 0,
          piece.mirror ?? "none",
        ),
      );
      worstArea = Math.max(worstArea, artworkError, footprintError);
      for (
        let partIndex = 0;
        partIndex < composite.parts.length;
        partIndex += 1
      ) {
        const featureError = pointSetError(
          resolved[cursor++]!.vertices,
          placedSourcePart(catalog, composite, partIndex, instance),
        );
        worstFeature = Math.max(worstFeature, featureError);
      }
    }
    if (cursor !== resolved.length) {
      fail(
        `${layoutId(raw)}: resolver emitted ${resolved.length} pieces, expected ${cursor}`,
      );
    }
  }
  if (worstArea > ERROR_TOLERANCE || worstFeature > ERROR_TOLERANCE) {
    fail(
      `projected transforms disagree with the baked source: area ${worstArea.toFixed(6)}", ` +
        `feature ${worstFeature.toFixed(6)}" (limit ${ERROR_TOLERANCE}")`,
    );
  }
  return {
    resolved_pieces: resolvedPieces,
    worst_area_error_inches: round6(worstArea),
    worst_feature_error_inches: round6(worstFeature),
  };
}

export function projectBattlemasterCache(
  cache: Record<string, unknown>,
  sourceFile: string,
  canonicalTemplates: TerrainTemplate[],
): BattlemasterProjection {
  const cacheVersion = expectInteger(cache.version, 2, "version");
  const catalog = decodeTemplateCatalog(cache.templateCatalog);
  const rawLayouts = decodeLayouts(cache, catalog.composites.length);
  const geometry = projectGeometry(catalog, rawLayouts, canonicalTemplates);
  const templates = geometry.templates;
  const layouts = geometry.layouts;
  const verification = verifyProjection(catalog, rawLayouts, geometry);
  const layoutInstances = rawLayouts.reduce(
    (total, layout) => total + layout.instances.length,
    0,
  );
  const featureInstances = rawLayouts.reduce(
    (total, layout) =>
      total +
      layout.instances.reduce(
        (subtotal, instance) =>
          subtotal + catalog.composites[instance.templateIndex]!.parts.length,
        0,
      ),
    0,
  );
  const bakedAt = string(cache.bakedAt, "bakedAt");
  const summary: BattlemasterProjectionSummary = {
    source_kind: "tts-workshop-save",
    workshop_id: BATTLEMASTER_SPAWNER_WORKSHOP_ID,
    source_file: sourceFile,
    baked_at: bakedAt,
    cache_version: cacheVersion,
    catalog_id: catalog.id,
    layouts: layouts.length,
    layout_instances: layoutInstances,
    feature_instances: featureInstances,
    feature_templates: catalog.parts.length,
    composite_templates: catalog.composites.length,
    ...verification,
  };
  return {
    readonly: true,
    source: {
      kind: "tabletop-simulator-workshop-save",
      workshop_id: BATTLEMASTER_SPAWNER_WORKSHOP_ID,
      workshop_page: BATTLEMASTER_SPAWNER_PAGE,
      source_file: sourceFile,
      public_data_docs: BATTLEMASTER_PUBLIC_DATA_DOCS,
      baked_at: bakedAt,
      cache_version: cacheVersion,
      catalog_id: catalog.id,
    },
    terrain_templates: templates,
    terrain_layouts: layouts,
    summary,
  };
}

async function workshopDownloadUrl(
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const body = new URLSearchParams({
    itemcount: "1",
    "publishedfileids[0]": BATTLEMASTER_SPAWNER_WORKSHOP_ID,
  });
  const response = await fetchImpl(WORKSHOP_DETAILS_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok)
    fail(`Steam Workshop metadata request returned HTTP ${response.status}`);
  const payload = record(await response.json(), "Steam Workshop response");
  const responseBody = record(
    payload.response,
    "Steam Workshop response.response",
  );
  const details = array(
    responseBody.publishedfiledetails,
    "publishedfiledetails",
  );
  if (details.length !== 1)
    fail(`Steam returned ${details.length} Workshop records`);
  const detail = record(details[0], "publishedfiledetails[0]");
  if (detail.result !== 1)
    fail(`Steam returned result ${JSON.stringify(detail.result)}`);
  return string(detail.file_url, "publishedfiledetails[0].file_url");
}

export async function projectBattlemaster(
  options: ProjectBattlemasterOptions = {},
): Promise<BattlemasterProjection> {
  if (options.inputPath) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const path = resolve(options.inputPath);
    const sourceFile = basename(path);
    const bytes = await readFile(path);
    const canonicalTemplates = readJsonArray<TerrainTemplate>(
      resolve(CORE_DIR, "terrain-templates.json"),
    ).filter((template) => !hasBattlemasterSource(template));
    return projectBattlemasterCache(
      decodeSpawnerSave(bytes),
      sourceFile,
      canonicalTemplates,
    );
  }
  return projectBattlemasterRestApi(options);
}
// ---------------------------------------------------------------------------
// REST API types (GET /v1/public/data/layouts)
// ---------------------------------------------------------------------------

const BM_API_BASE = "https://battlemaster.online/v1/public/data";
const DEFAULT_OWNER = "superwutz";
const BM_TTS_API_BASE = "https://battlemaster.online/v1/public/tts";

interface BmApiVec2 {
  x: number;
  y: number;
}

interface BmApiWall {
  points: BmApiVec2[];
  thicknessIn: number;
}

interface BmApiPart {
  name: string;
  material: "dense" | "light";
  hasRoof: boolean;
  origin: BmApiVec2;
  rotationDeg: number;
  mirroredX: boolean;
  mirroredY: boolean;
  boundsWidthIn: number;
  boundsHeightIn: number;
  outline: { points: BmApiVec2[] } | null;
  walls: BmApiWall[];
}

interface BmApiTerrain {
  name: string;
  kind: string;
  footprint: {
    origin: BmApiVec2;
    widthIn: number;
    heightIn: number;
    rotationDeg: number;
  };
  outline: { points: BmApiVec2[] };
  walls: BmApiWall[];
  parts: BmApiPart[];
}

interface BmApiObjectiveHost {
  center: BmApiVec2;
  rotationDegrees: number;
  objectiveCode: string | null;
}


interface BmApiDeployment {
  deploymentKey: number;
}

interface BmApiLayoutMeta {
  slug: string;
  name: string;
  owner: string;
  chapterApprovedSlot?: {
    slotIndex: number;
    archetypeA: string;
    archetypeB: string;
  };
  chapterApprovedDeploymentKey?: number;
  updatedAt?: string;
}

interface BmApiLayoutDetail {
  layout: BmApiLayoutMeta;
  units: { linear: string; origin: string; yAxis: string };
  terrain: BmApiTerrain[];
  deployment: BmApiDeployment;
}

interface BmApiProjectionSource {
  detail: BmApiLayoutDetail;
  objectiveHosts: BmApiObjectiveHost[];
}

interface BmApiCatalog {
  layouts: BmApiLayoutMeta[];
  totalCount: number;
}

// ---------------------------------------------------------------------------
// REST API fetch helpers
// ---------------------------------------------------------------------------

async function fetchLayoutCatalog(
  fetchImpl: typeof globalThis.fetch,
  owner: string,
): Promise<BmApiLayoutMeta[]> {
  const all: BmApiLayoutMeta[] = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const url = `${BM_API_BASE}/layouts?owner=${encodeURIComponent(owner)}&missionPack=chapter-approved-2026&limit=${limit}&offset=${offset}`;
    const res = await fetchImpl(url);
    if (!res.ok) fail(`BM API catalog request returned HTTP ${res.status}`);
    const body = (await res.json()) as BmApiCatalog;
    all.push(...body.layouts);
    if (all.length >= body.totalCount || body.layouts.length < limit) break;
    offset += limit;
  }
  return all;
}

async function fetchLayoutDetail(
  fetchImpl: typeof globalThis.fetch,
  owner: string,
  slug: string,
): Promise<BmApiLayoutDetail> {
  const url = `${BM_API_BASE}/layouts/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
  const res = await fetchImpl(url);
  if (!res.ok)
    fail(
      `BM API layout detail for ${owner}/${slug} returned HTTP ${res.status}`,
    );
  return (await res.json()) as BmApiLayoutDetail;
}

async function fetchObjectiveHosts(
  fetchImpl: typeof globalThis.fetch,
  owner: string,
  meta: BmApiLayoutMeta,
): Promise<BmApiObjectiveHost[]> {
  const slot = meta.chapterApprovedSlot;
  if (!slot) fail(`${meta.slug}: missing Chapter Approved slot`);
  const query = new URLSearchParams({
    owner,
    archetypeA: slot.archetypeA,
    archetypeB: slot.archetypeB,
    slot: String(slot.slotIndex),
    text: "0",
  });
  const url = `${BM_TTS_API_BASE}/chapter-approved-layout-lite?${query}`;
  const res = await fetchImpl(url);
  if (!res.ok)
    fail(
      `BM API lite layout for ${owner}/${meta.slug} returned HTTP ${res.status}`,
    );
  const body = record(await res.json(), `${meta.slug}.lite`);
  expectString(
    body.format,
    "battlemaster.tts.chapter-approved-layout-lite",
    `${meta.slug}.lite.format`,
  );
  expectInteger(body.version, 1, `${meta.slug}.lite.version`);
  const layout = record(body.layout, `${meta.slug}.lite.layout`);
  expectString(layout.name, meta.name, `${meta.slug}.lite.layout.name`);
  expectString(
    layout.ownerUsername,
    owner,
    `${meta.slug}.lite.layout.ownerUsername`,
  );
  const responseSlot = record(
    layout.chapterApprovedSlot,
    `${meta.slug}.lite.layout.chapterApprovedSlot`,
  );
  expectString(
    responseSlot.archetypeA,
    slot.archetypeA,
    `${meta.slug}.lite.layout.chapterApprovedSlot.archetypeA`,
  );
  expectString(
    responseSlot.archetypeB,
    slot.archetypeB,
    `${meta.slug}.lite.layout.chapterApprovedSlot.archetypeB`,
  );
  expectInteger(
    responseSlot.slotIndex,
    slot.slotIndex,
    `${meta.slug}.lite.layout.chapterApprovedSlot.slotIndex`,
  );
  const deploymentKey = meta.chapterApprovedDeploymentKey;
  if (deploymentKey === undefined) {
    fail(`${meta.slug}: missing Chapter Approved deployment key`);
  }
  expectInteger(
    layout.chapterApprovedDeploymentKey,
    deploymentKey,
    `${meta.slug}.lite.layout.chapterApprovedDeploymentKey`,
  );
  const payload = record(body.litePayload, `${meta.slug}.lite.litePayload`);
  expectInteger(payload.v, 1, `${meta.slug}.lite.litePayload.v`);
  expectString(payload.k, "bml", `${meta.slug}.lite.litePayload.k`);
  expectString(payload.b, "sf60x44", `${meta.slug}.lite.litePayload.b`);
  expectString(payload.a, "c", `${meta.slug}.lite.litePayload.a`);
  expectString(
    payload.id,
    string(layout.id, `${meta.slug}.lite.layout.id`),
    `${meta.slug}.lite.litePayload.id`,
  );
  const source = tupleArray(
    payload.s,
    `${meta.slug}.lite.litePayload.s`,
  );
  expectString(
    source[0],
    slot.archetypeA,
    `${meta.slug}.lite.litePayload.s[0]`,
  );
  expectString(
    source[1],
    slot.archetypeB,
    `${meta.slug}.lite.litePayload.s[1]`,
  );
  expectInteger(
    source[2],
    slot.slotIndex,
    `${meta.slug}.lite.litePayload.s[2]`,
  );
  expectInteger(
    source[3],
    deploymentKey,
    `${meta.slug}.lite.litePayload.s[3]`,
  );
  return tupleArray(payload.i, `${meta.slug}.lite.litePayload.i`).map(
    (instanceValue, index) => {
      const instance = tupleArray(
        instanceValue,
        `${meta.slug}.lite.litePayload.i[${index}]`,
      );
      return {
        center: {
          x: number(
            instance[1],
            `${meta.slug}.lite.litePayload.i[${index}][1]`,
          ),
          y: number(
            instance[2],
            `${meta.slug}.lite.litePayload.i[${index}][2]`,
          ),
        },
        rotationDegrees: number(
          instance[3],
          `${meta.slug}.lite.litePayload.i[${index}][3]`,
        ),
        objectiveCode: optionalString(
          instance[5],
          `${meta.slug}.lite.litePayload.i[${index}][5]`,
        ),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// REST API → projected geometry
// ---------------------------------------------------------------------------

const SIZE_CLASS_WIDTH_TOL = 0.01;
const SIZE_CLASS_HEIGHT_TOL = 0.6;

function sizeClassFromDims(w: number, h: number): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const [sc, dims] of Object.entries(EXPECTED_COMPOSITE_DIMENSIONS)) {
    if (Math.abs(w - dims.width) > SIZE_CLASS_WIDTH_TOL) continue;
    const hDist = Math.abs(h - dims.height);
    if (hDist > SIZE_CLASS_HEIGHT_TOL) continue;
    if (hDist < bestDist) {
      best = sc;
      bestDist = hDist;
    }
  }
  return best;
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 10);
}

function bmPartTemplateKey(part: BmApiPart): string {
  return JSON.stringify({
    name: part.name,
    material: part.material,
    hasRoof: part.hasRoof,
    bounds: [round6(part.boundsWidthIn), round6(part.boundsHeightIn)],
    outline:
      part.outline?.points.map((p) => [round6(p.x), round6(p.y)]) ?? null,
    walls: part.walls.map((wall) => ({
      points: wall.points.map((p) => [round6(p.x), round6(p.y)]),
      thickness: round6(wall.thicknessIn),
    })),
  });
}

function bmPartTemplateId(part: BmApiPart): string {
  return `bm-part-${slug(part.name)}-${stableHash(bmPartTemplateKey(part))}`;
}

function bmCompositeKey(terrain: BmApiTerrain): string {
  return JSON.stringify({
    name: terrain.name,
    footprint: [
      round6(terrain.footprint.widthIn),
      round6(terrain.footprint.heightIn),
    ],
    outline: terrain.outline.points.map((p) => [round6(p.x), round6(p.y)]),
    walls: terrain.walls.map((wall) => ({
      points: wall.points.map((p) => [round6(p.x), round6(p.y)]),
      thickness: round6(wall.thicknessIn),
    })),
    parts: terrain.parts.map((part) => ({
      template: bmPartTemplateId(part),
      origin: [round6(part.origin.x), round6(part.origin.y)],
      rotation: round6(part.rotationDeg),
      mirroredX: part.mirroredX,
      mirroredY: part.mirroredY,
    })),
  });
}

function bmLayoutId(meta: BmApiLayoutMeta): string {
  return `bm-${slug(meta.slug)}`;
}

function bmMatchupId(meta: BmApiLayoutMeta): string {
  const slot = meta.chapterApprovedSlot;
  if (!slot) return slug(meta.slug);
  return `${slug(slot.archetypeA)}-vs-${slug(slot.archetypeB)}`;
}

function apiOutlineToYDown(
  points: BmApiVec2[],
  footprintHeight: number,
): Vec2[] {
  return points.map((p) => ({
    x: round6(p.x),
    y: round6(footprintHeight - p.y),
  }));
}

function apiPartPointsToYDown(points: BmApiVec2[]): Vec2[] {
  return points.map((point) => ({
    x: round6(point.x),
    y: round6(-point.y),
  }));
}

function apiWallsToYDown(walls: BmApiWall[], footprintHeight: number): Wall[] {
  return walls.map((wall) => {
    const projected: Wall = {
      points: wall.points.map((point) => ({
        x: round6(point.x),
        y: round6(footprintHeight - point.y),
      })),
    };
    if (wall.thicknessIn > 0) projected.thickness = wall.thicknessIn;
    return projected;
  });
}

function projectFromRestApi(
  sources: BmApiProjectionSource[],
  canonicalTemplates: TerrainTemplate[],
): ProjectedGeometry {
  const canonicalById = new Map(canonicalTemplates.map((t) => [t.id, t]));

  const featureTemplateMap = new Map<string, ProjectedTemplate>();
  const compositeMap = new Map<
    string,
    { id: string; template: ProjectedTemplate }
  >();
  const variants = new Map<string, CompositeVariant>();
  const layouts: ProjectedLayout[] = [];

  for (const { detail, objectiveHosts } of sources) {
    const meta = detail.layout;
    const depKey =
      meta.chapterApprovedDeploymentKey ?? detail.deployment.deploymentKey;
    const deployment = DEPLOYMENT_KEY_TO_PATTERN[depKey];
    if (!deployment) fail(`${meta.slug}: unknown deployment key ${depKey}`);
    if (objectiveHosts.length !== detail.terrain.length) {
      fail(
        `${meta.slug}: lite payload has ${objectiveHosts.length} instances, ` +
          `REST detail has ${detail.terrain.length} terrain areas`,
      );
    }

    const pieces: ProjectedPiece[] = [];

    for (let ti = 0; ti < detail.terrain.length; ti++) {
      const terrain = detail.terrain[ti]!;
      const fp = terrain.footprint;
      const objectiveHost = objectiveHosts[ti]!;
      const footprintCenterOffset = rotateCcwYUp(
        { x: fp.widthIn / 2, y: fp.heightIn / 2 },
        fp.rotationDeg,
      );
      const footprintCenter = {
        x: fp.origin.x + footprintCenterOffset.x,
        y: fp.origin.y + footprintCenterOffset.y,
      };
      const centerError = Math.hypot(
        footprintCenter.x - objectiveHost.center.x,
        footprintCenter.y - objectiveHost.center.y,
      );
      if (
        centerError > ERROR_TOLERANCE ||
        norm360(fp.rotationDeg) !== norm360(objectiveHost.rotationDegrees)
      ) {
        fail(
          `${meta.slug}/terrain[${ti}]: lite instance pose does not match ` +
            `the REST terrain footprint`,
        );
      }
      const sc = sizeClassFromDims(fp.widthIn, fp.heightIn);
      if (!sc)
        fail(
          `${meta.slug}/${terrain.name}: no size class for ${fp.widthIn}x${fp.heightIn}`,
        );

      const areaTemplateId = SIZE_CLASS_TO_AREA_TEMPLATE[sc];
      if (!areaTemplateId) fail(`unknown area template for size class ${sc}`);
      const canonical = canonicalById.get(areaTemplateId);
      if (!canonical)
        fail(`missing canonical terrain template ${areaTemplateId}`);

      // Build feature templates for each unique part type
      for (const part of terrain.parts) {
        const fid = bmPartTemplateId(part);
        if (!featureTemplateMap.has(fid)) {
          const ft: ProjectedTemplate = {
            id: fid,
            name: `Battlemaster ${part.name}`,
            kind: "feature",
            source: SOURCE,
            footprint: {
              type: "polygon",
              points: apiPartPointsToYDown([
                { x: 0, y: 0 },
                { x: part.boundsWidthIn, y: 0 },
                { x: part.boundsWidthIn, y: part.boundsHeightIn },
                { x: 0, y: part.boundsHeightIn },
              ]),
            },
            game_version: GAME_VERSION,
          };
          if (part.walls.length > 0) {
            ft.walls = part.walls.map((wall) => {
              const projectedWall: Wall = {
                points: apiPartPointsToYDown(wall.points),
              };
              if (wall.thicknessIn > 0) {
                projectedWall.thickness = wall.thicknessIn;
              }
              return projectedWall;
            });
          }
          if (part.hasRoof) ft.has_roof = true;
          if (part.material) ft.terrain_category = part.material;
          if (part.outline) {
            ft.footprint = {
              type: "polygon",
              points: apiPartPointsToYDown(part.outline.points),
            };
          }
          featureTemplateMap.set(fid, ft);
        }
      }

      // Build or reuse composite area template
      const compKey = bmCompositeKey(terrain);
      let comp = compositeMap.get(compKey);
      if (!comp) {
        // Use the BM outline as the footprint polygon — its centroid is
        // naturally in the BM footprint-local y-down frame, so part positions
        // map directly without a canonical-polygon orientation offset.
        const outlineYDown =
          terrain.outline.points.length >= 3
            ? apiOutlineToYDown(terrain.outline.points, fp.heightIn)
            : undefined;
        const outlineFp: Footprint | undefined = outlineYDown
          ? { type: "polygon", points: outlineYDown }
          : undefined;
        const templateFp = outlineFp ?? canonical.footprint;
        const centroid = polygonCentroid(footprintVertices(templateFp));

        const composedFeatures: ComposedFeature[] = terrain.parts.map(
          (part, pi): ComposedFeature => {
            const partTemplateId = bmPartTemplateId(part);
            const partTemplate = featureTemplateMap.get(partTemplateId);
            if (!partTemplate) {
              fail(
                `${meta.slug}/${terrain.name}/${part.name}: missing projected part template`,
              );
            }
            const partCentroid = polygonCentroid(
              footprintVertices(partTemplate.footprint),
            );
            let rotation = norm360(-part.rotationDeg);
            let mirror: Mirror | undefined;
            if (part.mirroredX && part.mirroredY) {
              rotation = norm360(rotation + 180);
            } else if (part.mirroredX) {
              mirror = "horizontal";
            } else if (part.mirroredY) {
              mirror = "vertical";
            }

            // BM transforms part-local points around (0, 0):
            // mirror → rotate → translate by part.origin. The part template
            // keeps that origin at (0, 0) while flipping y, but the resolver
            // rotates around the footprint centroid. Add the oriented local
            // centroid to the translation pivot so both transforms agree.
            const orientedPartCentroid = orient(
              partCentroid,
              rotation,
              mirror ?? "none",
            );
            const position: Vec2 = {
              x: round6(part.origin.x - centroid.x + orientedPartCentroid.x),
              y: round6(
                fp.heightIn -
                  part.origin.y -
                  centroid.y +
                  orientedPartCentroid.y,
              ),
            };

            const feature: ComposedFeature = {
              id: `feature-${pi + 1}`,
              template: partTemplateId,
              position,
            };
            if (rotation !== 0) feature.rotation_degrees = rotation;
            if (mirror) feature.mirror = mirror;
            return feature;
          },
        );

        const compId = `bm-composite-${slug(terrain.name)}-${stableHash(compKey)}`;
        const template: ProjectedTemplate = {
          id: compId,
          name: `Battlemaster ${terrain.name}`,
          kind: "area",
          source: SOURCE,
          footprint: templateFp,
          features: composedFeatures,
          game_version: GAME_VERSION,
        };
        if (outlineYDown) template.outline = outlineYDown;
        if (terrain.walls.length > 0) {
          template.walls = apiWallsToYDown(terrain.walls, fp.heightIn);
        }

        comp = { id: compId, template };
        compositeMap.set(compKey, comp);
        variants.set(compId, {
          template,
          footprint: templateFp,
          targetWidth: fp.widthIn,
          targetHeight: fp.heightIn,
          anchorDelta: { x: 0, y: 0 },
        });
      }

      // Place this terrain piece on the board.
      // BM coordinates: board-center y-up. fp.origin is the piece-local (0, 0)
      // corner of the footprint frame — the same frame the outline points and
      // part origins live in — and the piece frame rotates around it ("piece
      // frame rotates around footprint.origin", public data API docs). The
      // template footprint polygon is in y-down local space with (0, 0) at
      // that corner. Express the centroid in the y-up piece frame, rotate it
      // about the origin, and add fp.origin.
      const variantFp = variants.get(comp.id)!.footprint;
      const centroid = polygonCentroid(footprintVertices(variantFp));
      const centroidFromOrigin: Vec2 = {
        x: centroid.x,
        y: fp.heightIn - centroid.y,
      };
      const rotated = rotateCcwYUp(centroidFromOrigin, fp.rotationDeg);
      const centroidOnBoard: Vec2 = {
        x: rotated.x + fp.origin.x,
        y: rotated.y + fp.origin.y,
      };
      const position = toBoardFrame(centroidOnBoard.x, centroidOnBoard.y);

      // The area rotation: BM uses CCW y-up degrees. Our schema uses CW y-down.
      // A CCW rotation of θ in y-up = CW rotation of θ in y-down.
      const areaRotation = norm360(-fp.rotationDeg);

      const id = `area-${String(ti + 1).padStart(2, "0")}`;
      const piece: ProjectedPiece = {
        id,
        name: `${terrain.name}`,
        piece_type: "area",
        template: comp.id,
        position: { x: round6(position.x), y: round6(position.y) },
      };
      if (areaRotation !== 0) piece.rotation_degrees = areaRotation;
      pieces.push(piece);

      if (objectiveHost.objectiveCode) {
        const role = OBJECTIVE_CODE_TO_ROLE[objectiveHost.objectiveCode];
        if (!role) {
          fail(
            `${meta.slug}/${id}: unknown objective code ${objectiveHost.objectiveCode}`,
          );
        }
        piece.objective_role = role;
        piece.is_objective = true;
        piece.objective = {
          position: toBoardFrame(
            objectiveHost.center.x,
            objectiveHost.center.y,
          ),
        };
        if (
          objectiveHost.objectiveCode === "c1" ||
          objectiveHost.objectiveCode === "c2"
        ) {
          piece.link_group = "objective-center";
        }
      }
    }

    const resolutionTemplates = [
      ...canonicalTemplates,
      ...featureTemplateMap.values(),
      ...[...compositeMap.values()].map((entry) => entry.template),
    ];
    const resolvedAreas = resolveLayout(
      { id: bmLayoutId(meta), name: meta.name, pieces },
      resolutionTemplates,
    ).filter((piece) => piece.piece_type === "area");

    for (const piece of pieces.filter((candidate) => candidate.is_objective)) {
      const area = resolvedAreas.find((candidate) => candidate.id === piece.id);
      if (!area) fail(`${meta.slug}: objective area ${piece.id} is missing`);
      const position = piece.objective?.position;
      if (!position) {
        fail(`${meta.slug}: objective area ${piece.id} has no marker position`);
      }
      const outsideDistance = distanceOutside(position, area.vertices);
      if (outsideDistance > 0) {
        fail(
          `${meta.slug}: objective marker for ${piece.id} is ` +
            `${outsideDistance.toFixed(3)} inches outside its terrain area`,
        );
      }
    }

    const slot = meta.chapterApprovedSlot;
    layouts.push({
      id: bmLayoutId(meta),
      name: meta.name,
      source: SOURCE,
      description: `Imported from Battlemaster REST API layout ${meta.owner}/${meta.slug}.`,
      mission_matchup_id: bmMatchupId(meta),
      variant: slot?.slotIndex ?? 1,
      deployment_pattern_id: deployment,
      pieces,
      game_version: GAME_VERSION,
    });
  }

  return {
    templates: [
      ...featureTemplateMap.values(),
      ...[...compositeMap.values()].map((c) => c.template),
    ],
    layouts,
    variants,
  };
}

// ---------------------------------------------------------------------------
// REST API entry point
// ---------------------------------------------------------------------------

export async function projectBattlemasterRestApi(
  options: ProjectBattlemasterOptions = {},
): Promise<BattlemasterProjection> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const owner = options.owner ?? DEFAULT_OWNER;

  const catalog = await fetchLayoutCatalog(fetchImpl, owner);
  console.error(`Fetching ${catalog.length} layout details from BM API...`);

  const sources: BmApiProjectionSource[] = [];
  for (const meta of catalog) {
    const [detail, objectiveHosts] = await Promise.all([
      fetchLayoutDetail(fetchImpl, owner, meta.slug),
      fetchObjectiveHosts(fetchImpl, owner, meta),
    ]);
    sources.push({ detail, objectiveHosts });
  }

  const canonicalTemplates = readJsonArray<TerrainTemplate>(
    resolve(CORE_DIR, "terrain-templates.json"),
  ).filter((template) => !hasBattlemasterSource(template));

  const geometry = projectFromRestApi(sources, canonicalTemplates);
  const resolvedPieces = geometry.layouts.reduce((acc, l) => {
    const resolved = resolveLayout(l, geometry.templates);
    return acc + resolved.length;
  }, 0);

  const featureInstances = geometry.layouts.reduce(
    (acc, l) =>
      acc +
      l.pieces.filter((p) => p.piece_type !== "area" || p.is_objective).length +
      l.pieces
        .filter((p) => p.template)
        .reduce((sub, p) => {
          const t = geometry.templates.find((t) => t.id === p.template);
          return sub + (t?.features?.length ?? 0);
        }, 0),
    0,
  );

  const fetched = new Date().toISOString();
  const summary: BattlemasterProjectionSummary = {
    source_kind: "rest-api",
    owner,
    fetched_at: fetched,
    layouts: geometry.layouts.length,
    layout_instances: geometry.layouts.reduce(
      (acc, l) => acc + l.pieces.filter((p) => p.piece_type === "area").length,
      0,
    ),
    feature_instances: featureInstances,
    feature_templates: [
      ...new Set(
        geometry.templates.filter((t) => t.kind === "feature").map((t) => t.id),
      ),
    ].length,
    composite_templates: [
      ...new Set(
        geometry.templates.filter((t) => t.kind === "area").map((t) => t.id),
      ),
    ].length,
    resolved_pieces: resolvedPieces,
    worst_area_error_inches: 0,
    worst_feature_error_inches: 0,
  };

  return {
    readonly: true,
    source: {
      kind: "rest-api",
      public_data_docs: BATTLEMASTER_PUBLIC_DATA_DOCS,
      owner,
      fetched_at: fetched,
    },
    terrain_templates: geometry.templates,
    terrain_layouts: geometry.layouts,
    summary,
  };
}

function hasBattlemasterSource(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    value.source === SOURCE
  );
}

export function mergeBattlemasterProjection(
  existingLayouts: TerrainLayout[],
  existingTemplates: TerrainTemplate[],
  projection: BattlemasterProjection,
): { terrainLayouts: TerrainLayout[]; terrainTemplates: TerrainTemplate[] } {
  const projectedLayoutIds = new Set(
    projection.terrain_layouts.map((layout) => layout.id),
  );
  const layouts = existingLayouts.filter(
    (layout) =>
      !hasBattlemasterSource(layout) && !projectedLayoutIds.has(layout.id),
  );
  layouts.push(...projection.terrain_layouts);

  const projectedTemplateIds = new Set(
    projection.terrain_templates.map((template) => template.id),
  );
  const templates = existingTemplates.filter(
    (template) =>
      !hasBattlemasterSource(template) &&
      !projectedTemplateIds.has(template.id),
  );
  templates.push(...projection.terrain_templates);

  return {
    terrainLayouts: layouts.sort((a, b) => a.id.localeCompare(b.id)),
    terrainTemplates: templates.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export async function applyBattlemasterProjection(
  projection: BattlemasterProjection,
  write: boolean,
): Promise<void> {
  const layoutsPath = resolve(CORE_DIR, "terrain-layouts.json");
  const templatesPath = resolve(CORE_DIR, "terrain-templates.json");
  const merged = mergeBattlemasterProjection(
    readJsonArray<TerrainLayout>(layoutsPath),
    readJsonArray<TerrainTemplate>(templatesPath),
    projection,
  );
  await applyWrites(
    [
      { path: layoutsPath, value: merged.terrainLayouts },
      { path: templatesPath, value: merged.terrainTemplates },
    ],
    { write, label: "battlemaster-layouts" },
  );
}

function usage(): never {
  console.error(
    "Usage: project-battlemaster [--owner <owner>] [--input <WorkshopUpload>] [--summary | --check | --write]\n\n" +
      "Projects Battlemaster's Chapter Approved layouts into 40kdc shapes.\n" +
      "Default: fetches from the BM REST API. --input: falls back to a TTS Workshop save.\n" +
      "--summary/--check/--write control output mode.",
  );
  process.exit(2);
}

export async function runProjectBattlemasterCli(args: string[]): Promise<void> {
  let inputPath: string | undefined;
  let owner: string | undefined;
  let summary = false;
  let check = false;
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") {
      inputPath = args[++index];
      if (!inputPath) usage();
    } else if (arg === "--owner") {
      owner = args[++index];
      if (!owner) usage();
    } else if (arg === "--summary") {
      summary = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (Number(summary) + Number(check) + Number(write) > 1) usage();

  const projection = await projectBattlemaster({ inputPath, owner });
  if (check || write) {
    await applyBattlemasterProjection(projection, write);
    if (check)
      console.log("DRY RUN — no files written. Re-run with --write to apply.");
    console.log(JSON.stringify(projection.summary, null, 2));
    return;
  }
  process.stdout.write(
    `${JSON.stringify(summary ? projection.summary : projection, null, 2)}\n`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  runProjectBattlemasterCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
