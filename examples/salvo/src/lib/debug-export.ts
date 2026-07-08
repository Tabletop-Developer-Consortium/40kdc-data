// Serializes the complete Salvo pipeline — inputs, the assembled buff stack,
// resolved modifiers, and every engine stage — into one plain object suitable
// for `JSON.stringify` and pasting into a bug report. One-way only: there is no
// re-import. Kept free of Svelte runtime so it stays unit-testable; the caller
// hands in the already-derived pipeline values.
import type {
  Buff,
  Dataset,
  EngineContext,
  ResolvedModifiers,
  Stage,
  StackableBuff,
} from "@alpaca-software/40kdc-data";
import type { ContextFlags, ManualTarget, PhaseChoice, TargetMode } from "./store.svelte.js";

/** The subset of {@link SalvoState} the snapshot reads. The live `salvo`
 *  singleton satisfies this structurally. */
export interface SalvoInputs {
  selectedUnitId: string | null;
  selectedFactionId: string | null;
  selectedDetachmentId: string | null;
  attachedUnitIds: string[];
  phase: PhaseChoice;
  selectedWeaponId: string | null;
  selectedProfileIndex: number;
  modelsFiring: number;
  buffOverrides: Record<string, boolean>;
  manualBuffsActive: Set<string>;
  contextFlags: ContextFlags;
  targetMode: TargetMode;
  manualTarget: ManualTarget;
  datasetTargetFactionId: string | null;
  datasetTargetUnitId: string | null;
  rosterTargetUnitIndex: number | null;
  attackerRoster: { units: unknown[] } | null;
  targetRoster: { units: unknown[] } | null;
}

/** The engine result as the output pane holds it: a projection, an error
 *  envelope, or nothing yet. */
export type ProjectionLike = { stages: Stage[] } | { error: string } | null;

export interface DebugSnapshotArgs {
  salvo: SalvoInputs;
  ds: Dataset;
  /** The `EngineContext` actually passed to `crunch`. */
  context: EngineContext;
  /** Every lever `stackableBuffsFor` enumerated (before the enabled filter). */
  stackable: StackableBuff[];
  /** The flat buff stack fed to `crunch`. */
  allBuffs: Buff[];
  projection: ProjectionLike;
  resolved: ResolvedModifiers | null;
}

export interface DebugSnapshot {
  version: 1;
  inputs: {
    attacker: {
      unitId: string | null;
      unitName: string | null;
      factionId: string | null;
      detachmentId: string | null;
      attachedUnitIds: string[];
      attachedUnitNames: (string | null)[];
      phase: PhaseChoice;
      weaponId: string | null;
      weaponName: string | null;
      profileIndex: number;
      modelsFiring: number;
    };
    target: {
      mode: TargetMode;
      manual: ManualTarget;
      datasetFactionId: string | null;
      datasetUnitId: string | null;
      datasetUnitName: string | null;
      rosterUnitIndex: number | null;
    };
    buffConfig: {
      buffOverrides: Record<string, boolean>;
      manualBuffsActive: string[];
      contextFlags: ContextFlags;
    };
    rosters: {
      attackerImported: boolean;
      attackerUnitCount: number;
      targetImported: boolean;
      targetUnitCount: number;
    };
  };
  computed: {
    context: EngineContext;
    stackableBuffs: {
      id: string;
      label: string;
      source: StackableBuff["source"];
      group: string | undefined;
      defaultEnabled: boolean;
      effectiveEnabled: boolean;
    }[];
    allBuffs: Buff[];
    resolved: ResolvedModifiers | null;
    stages: Stage[] | { error: string } | null;
  };
}

/** Assemble the snapshot. Pure: no I/O, no reads of module-level reactive
 *  state — everything comes through {@link DebugSnapshotArgs}. */
export function buildDebugSnapshot(args: DebugSnapshotArgs): DebugSnapshot {
  const { salvo, ds, context, stackable, allBuffs, projection, resolved } = args;

  const unitName = (id: string | null): string | null =>
    id ? ds.units.getAny(id)?.raw.name ?? null : null;
  const weaponName = (id: string | null): string | null =>
    id ? ds.weapons.getAny(id)?.raw.name ?? null : null;

  // `manualBuffsActive` is a Set — JSON.stringify would emit `{}`. Convert it.
  const stages: Stage[] | { error: string } | null =
    projection === null ? null : "error" in projection ? { error: projection.error } : projection.stages;

  return {
    version: 1,
    inputs: {
      attacker: {
        unitId: salvo.selectedUnitId,
        unitName: unitName(salvo.selectedUnitId),
        factionId: salvo.selectedFactionId,
        detachmentId: salvo.selectedDetachmentId,
        attachedUnitIds: [...salvo.attachedUnitIds],
        attachedUnitNames: salvo.attachedUnitIds.map(unitName),
        phase: salvo.phase,
        weaponId: salvo.selectedWeaponId,
        weaponName: weaponName(salvo.selectedWeaponId),
        profileIndex: salvo.selectedProfileIndex,
        modelsFiring: salvo.modelsFiring,
      },
      target: {
        mode: salvo.targetMode,
        manual: { ...salvo.manualTarget, keywords: [...salvo.manualTarget.keywords] },
        datasetFactionId: salvo.datasetTargetFactionId,
        datasetUnitId: salvo.datasetTargetUnitId,
        datasetUnitName: unitName(salvo.datasetTargetUnitId),
        rosterUnitIndex: salvo.rosterTargetUnitIndex,
      },
      buffConfig: {
        buffOverrides: { ...salvo.buffOverrides },
        manualBuffsActive: [...salvo.manualBuffsActive],
        contextFlags: { ...salvo.contextFlags },
      },
      rosters: {
        attackerImported: salvo.attackerRoster !== null,
        attackerUnitCount: salvo.attackerRoster?.units.length ?? 0,
        targetImported: salvo.targetRoster !== null,
        targetUnitCount: salvo.targetRoster?.units.length ?? 0,
      },
    },
    computed: {
      context,
      stackableBuffs: stackable.map((b) => ({
        id: b.id,
        label: b.label,
        source: b.source,
        group: b.group,
        defaultEnabled: b.enabled,
        // Mirror SalvoState.isBuffEnabled without depending on the method.
        effectiveEnabled: salvo.buffOverrides[b.id] ?? b.enabled,
      })),
      allBuffs,
      resolved,
      stages,
    },
  };
}
