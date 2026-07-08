/**
 * Pure projection helpers shared by the desktop table and the mobile card
 * views of the output pane. Everything here is plain data-in/data-out so it
 * can carry unit tests; the reactive `$derived` plumbing stays in the
 * component.
 */
import type {
  AttributedStage,
  BuffSource,
  Dataset,
  Stage,
  StageLift,
} from "@alpaca-software/40kdc-data";

/** The 7 pipeline stages as ordered columns, abbreviated with a full title. */
export const STAGE_COLUMNS: { name: Stage["name"]; short: string; full: string }[] = [
  { name: "attacks", short: "Atk", full: "Attacks" },
  { name: "hits", short: "Hit", full: "Hits" },
  { name: "wounds", short: "Wnd", full: "Wounds" },
  { name: "unsaved", short: "Uns", full: "Unsaved" },
  { name: "damage", short: "Dmg", full: "Damage" },
  { name: "after-fnp", short: "FNP", full: "After FNP" },
  { name: "models-killed", short: "Kill", full: "Models killed" },
];

export function stageOf(
  attributed: AttributedStage[],
  name: Stage["name"],
): AttributedStage | undefined {
  return attributed.find((s) => s.name === name);
}

/** Stable per-source key — mirrors the engine's buff grouping. */
export function srcKey(s: BuffSource): string {
  if (s.kind === "ability") return `a:${s.abilityId}:${s.sourceUnitId ?? ""}`;
  if (s.kind === "manual") return `m:${s.label}`;
  return `w:${s.weaponId}:${s.keywordId}`;
}

/** Human label for a buff source, resolving ability/unit names from the dataset. */
export function labelForSource(ds: Dataset, s: BuffSource): string {
  if (s.kind === "manual") return s.label;
  if (s.kind === "weapon-keyword") return s.keywordId;
  const name = ds.abilities.getAny(s.abilityId)?.name ?? s.abilityId;
  if (s.abilityKind === "attached" && s.sourceUnitId) {
    const unit = ds.units.getAny(s.sourceUnitId)?.name ?? s.sourceUnitId;
    return `${name} · ${unit}`;
  }
  return name;
}

export function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

export function fmtSigned(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

const EPS = 1e-6;

/**
 * The "Combined" stages: one AttributedStage per pipeline stage, decomposed
 * the same way per-line cells are so the aggregate cells carry breakdowns
 * too. Stages 1–6 sum by linearity (expected, baseline, residual, and
 * per-source lifts all add); models-killed is NOT additive — its lift is
 * recomputed through the cap formula on the summed after-fnp, never summed
 * from per-line kills.
 *
 * `included` must already be filtered to the lines in play (not excluded, no
 * crunch error). `W` and `modelCount` describe the target.
 */
export function aggregateStages(
  included: { attributed: AttributedStage[] }[],
  W: number,
  modelCount: number,
): AttributedStage[] {
  const killed = (afterFnp: number): number =>
    W > 0 ? Math.min(modelCount, afterFnp / W) : 0;

  // Sum a source-keyed lift map across the included lines for one stage.
  function sumLifts(name: Stage["name"]): Map<string, StageLift> {
    const map = new Map<string, StageLift>();
    for (const r of included) {
      for (const l of stageOf(r.attributed, name)?.lifts ?? []) {
        const key = srcKey(l.source);
        const cur = map.get(key);
        if (cur) cur.delta += l.delta;
        else map.set(key, { source: l.source, delta: l.delta });
      }
    }
    return map;
  }

  const out: AttributedStage[] = [];
  const additive: Stage["name"][] = ["attacks", "hits", "wounds", "unsaved", "damage", "after-fnp"];
  for (const name of additive) {
    let expected = 0;
    let baseline = 0;
    let residual = 0;
    const intrinsics = new Set<string>();
    for (const r of included) {
      const s = stageOf(r.attributed, name);
      if (!s) continue;
      expected += s.expected;
      baseline += s.baseline;
      residual += s.residual;
      for (const k of s.intrinsics) intrinsics.add(k);
    }
    out.push({
      name,
      expected,
      detail: name === "attacks" ? `${included.length} weapon line(s)` : "",
      baseline,
      lifts: [...sumLifts(name).values()].filter((l) => Math.abs(l.delta) > EPS),
      residual: Math.abs(residual) > EPS ? residual : 0,
      intrinsics: [...intrinsics],
    });
  }

  // models-killed via the aggregate (non-additive) path.
  const sumAfterFnp = included.reduce(
    (s, r) => s + (stageOf(r.attributed, "after-fnp")?.expected ?? 0),
    0,
  );
  const sumAfterFnpBaseline = included.reduce(
    (s, r) => s + (stageOf(r.attributed, "after-fnp")?.baseline ?? 0),
    0,
  );
  const killedExpected = killed(sumAfterFnp);
  const killedBaseline = killed(sumAfterFnpBaseline);
  const killedLifts: StageLift[] = [];
  let killedLiftSum = 0;
  for (const { source, delta } of sumLifts("after-fnp").values()) {
    const d = killedExpected - killed(sumAfterFnp - delta);
    killedLiftSum += d;
    if (Math.abs(d) > EPS) killedLifts.push({ source, delta: d });
  }
  const killedResidual = killedExpected - killedBaseline - killedLiftSum;
  out.push({
    name: "models-killed",
    expected: killedExpected,
    detail: `W${W} per model, capped at ${modelCount}`,
    baseline: killedBaseline,
    lifts: killedLifts,
    residual: Math.abs(killedResidual) > EPS ? killedResidual : 0,
    intrinsics: [],
  });
  return out;
}
