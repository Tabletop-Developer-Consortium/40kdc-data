<script lang="ts">
  import { salvo, ds, PHASE_CHOICES, weaponTypeForPhase } from "./store.svelte.js";
  import { resolveRosterUnit, resolveAttachmentPartners } from "@alpaca-software/40kdc-data";
  import type { UnitView } from "@alpaca-software/40kdc-data";
  import EmptyState from "./EmptyState.svelte";

  type AttachmentPartner = { unit: UnitView; role: "leader" | "bodyguard" };

  // Roster-driven unit list (each entry is "this unit, this faction"), or the
  // raw embedded unit catalog when no roster is loaded.
  const rosterUnits = $derived(
    (salvo.attackerRoster?.units ?? [])
      .map((ru, i) => ({
        ru,
        view: resolveRosterUnit(ru, ds),
        index: i,
      }))
      .filter((x) => x.view !== undefined),
  );

  // Quick-pick: every unit in the dataset, filtered by faction if one is set.
  const datasetUnits = $derived.by(() => {
    const allUnits = ds.units.all;
    const filtered = salvo.selectedFactionId
      ? allUnits.filter((u) => u.raw.faction_id === salvo.selectedFactionId)
      : allUnits;
    return filtered
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  const factions = $derived(
    ds.factions.all.slice().sort((a, b) => a.name.localeCompare(b.name)),
  );

  // Build sets of unit names that appear more than once in the current
  // dropdown options. Only those need a faction-suffix to disambiguate —
  // adding the suffix to every unit would just be noise.
  const sharedRosterNames = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const { view } of rosterUnits) {
      if (!view) continue;
      counts.set(view.name, (counts.get(view.name) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, n]) => n > 1)
        .map(([name]) => name),
    );
  });

  const sharedDatasetNames = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const u of datasetUnits) {
      counts.set(u.name, (counts.get(u.name) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, n]) => n > 1)
        .map(([name]) => name),
    );
  });

  const detachments = $derived(
    salvo.selectedFactionId
      ? ds.detachments.all.filter((d) => d.faction_id === salvo.selectedFactionId)
      : [],
  );

  // Resolve the selected unit *within the selected faction* — shared chassis
  // (e.g. `chaos-land-raider`) live under several factions, and a faction-blind
  // `get` returns whichever copy was registered first (the wrong faction's).
  const selectedUnit = $derived.by(() => {
    if (!salvo.selectedUnitId) return undefined;
    if (salvo.selectedFactionId) {
      const scoped = ds.units.getInFaction(salvo.selectedUnitId, salvo.selectedFactionId);
      if (scoped) return scoped;
    }
    return ds.units.getAny(salvo.selectedUnitId);
  });

  // Bidirectional attachment partners for the selected unit: a leader+bodyguard
  // are one combined unit, so we offer the partner from either end. If the
  // selected unit is a bodyguard, partners are the leaders that can join it; if
  // it's a leader, partners are the bodyguards it can join. Empty for a unit
  // that takes part in no attachment.
  const attachmentPartners = $derived.by<AttachmentPartner[]>(() => {
    if (!selectedUnit) return [];
    return [
      ...ds.leadersAttachableTo(selectedUnit.id).map((u) => ({ unit: u, role: "leader" as const })),
      ...ds
        .bodyguardsAttachableFrom(selectedUnit.id)
        .map((u) => ({ unit: u, role: "bodyguard" as const })),
    ];
  });

  const partnerLeaders = $derived(attachmentPartners.filter((p) => p.role === "leader"));
  const partnerBodyguards = $derived(attachmentPartners.filter((p) => p.role === "bodyguard"));

  // Same shared-chassis disambiguation as the unit dropdowns: suffix ` ·
  // <faction>` only for partner names that appear more than once across both
  // role groups.
  const sharedPartnerNames = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const { unit } of attachmentPartners) {
      counts.set(unit.name, (counts.get(unit.name) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, n]) => n > 1)
        .map(([name]) => name),
    );
  });

  // Reset the attachment when the unit changes. Keep a still-eligible
  // selection; otherwise pre-fill from the imported roster's inferred
  // attachment (either direction) when present, else clear. The guard means a
  // manual dropdown pick is never clobbered (mirrors the weapon-reset effect).
  $effect(() => {
    if (!selectedUnit) return;
    const eligible = new Set(attachmentPartners.map((p) => p.unit.id));
    const current = salvo.attachedUnitIds;
    // Desired selection: keep the current one if still eligible, else hydrate
    // from the imported roster's attachment (either direction), else none.
    const next =
      current.length > 0 && current.every((id) => eligible.has(id))
        ? current
        : salvo.attackerRoster
          ? resolveAttachmentPartners(salvo.attackerRoster, selectedUnit.id)
              .map((u) => u.ref.id)
              .filter((id): id is string => id !== null && eligible.has(id))
          : [];
    // Assign only on a real content change. This effect reads
    // `attachedUnitIds`, so writing a fresh array reference every run (even an
    // unchanged `[]`) would re-trigger it until Svelte's update-depth guard
    // fires — an infinite reactivity loop that hangs the tab.
    if (next === current) return;
    if (next.length === current.length && next.every((id, i) => id === current[i])) return;
    salvo.attachedUnitIds = next;
  });

  // Only weapons usable in the current phase: ranged in shooting, melee in fight.
  const weapons = $derived(
    (selectedUnit?.weapons ?? []).filter(
      (w) => w.raw.type === weaponTypeForPhase(salvo.phase),
    ),
  );

  // Reset weapon selection when the unit changes.
  $effect(() => {
    if (!selectedUnit) return;
    if (salvo.selectedWeaponId && weapons.find((w) => w.id === salvo.selectedWeaponId)) return;
    salvo.selectedWeaponId = weapons[0]?.id ?? null;
    salvo.selectedProfileIndex = 0;
  });

  function pickUnit(unitId: string, factionId?: string) {
    salvo.selectedUnitId = unitId;
    if (factionId) {
      salvo.selectedFactionId = factionId;
      return;
    }
    // Keep the current faction when it actually owns this unit id — a shared
    // chassis (e.g. `chaos-land-raider`) exists under several factions, and
    // resolving it faction-blind would yank the faction over to whichever copy
    // happens to be registered first. Only re-derive the faction when the
    // current one has no such unit.
    if (salvo.selectedFactionId && ds.units.getInFaction(unitId, salvo.selectedFactionId)) {
      return;
    }
    const u = ds.units.getAny(unitId);
    if (u) salvo.selectedFactionId = u.raw.faction_id;
  }
</script>

{#if rosterUnits.length > 0}
  <div class="row">
    <label>From roster</label>
    <select
      class="grow"
      value={salvo.selectedUnitId ?? ""}
      onchange={(e) => pickUnit((e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">— pick a unit —</option>
      {#each rosterUnits as { ru, view, index } (index)}
        <option value={view!.id}>
          {view!.name}{sharedRosterNames.has(view!.name) && view!.faction
            ? ` · ${view!.faction.name}`
            : ""} ({ru.model_count} models)
        </option>
      {/each}
    </select>
  </div>
{/if}

<div class="row">
  <label>Faction</label>
  <select
    class="grow"
    value={salvo.selectedFactionId ?? ""}
    onchange={(e) => {
      salvo.selectedFactionId = (e.currentTarget as HTMLSelectElement).value || null;
      salvo.selectedDetachmentId = null;
    }}
  >
    <option value="">— any —</option>
    {#each factions as f (f.id)}
      <option value={f.id}>{f.name}</option>
    {/each}
  </select>
</div>

{#if detachments.length > 0}
  <div class="row">
    <label>Detachment</label>
    <select
      class="grow"
      value={salvo.selectedDetachmentId ?? ""}
      onchange={(e) => {
        salvo.selectedDetachmentId = (e.currentTarget as HTMLSelectElement).value || null;
      }}
    >
      <option value="">— none —</option>
      {#each detachments as d (d.id)}
        <option value={d.id}>{d.name}</option>
      {/each}
    </select>
  </div>
{/if}

<div class="row">
  <label>Unit</label>
  <select
    class="grow"
    value={salvo.selectedUnitId ?? ""}
    onchange={(e) => pickUnit((e.currentTarget as HTMLSelectElement).value)}
  >
    <option value="">— pick a unit —</option>
    {#each datasetUnits as u (`${u.raw.faction_id}/${u.id}`)}
      <option value={u.id}>
        {u.name}{sharedDatasetNames.has(u.name)
          ? ` · ${u.faction?.name ?? u.raw.faction_id}`
          : ""}
      </option>
    {/each}
  </select>
</div>

{#if attachmentPartners.length > 0}
  <div class="row">
    <label>Attached to</label>
    <select
      class="grow"
      value={salvo.attachedUnitIds[0] ?? ""}
      onchange={(e) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        salvo.attachedUnitIds = v ? [v] : [];
      }}
    >
      <option value="">— none —</option>
      {#if partnerLeaders.length > 0}
        <optgroup label="Leaders">
          {#each partnerLeaders as { unit } (`${unit.raw.faction_id}/${unit.id}`)}
            <option value={unit.id}>
              {unit.name}{sharedPartnerNames.has(unit.name)
                ? ` · ${unit.faction?.name ?? unit.raw.faction_id}`
                : ""}
            </option>
          {/each}
        </optgroup>
      {/if}
      {#if partnerBodyguards.length > 0}
        <optgroup label="Bodyguards">
          {#each partnerBodyguards as { unit } (`${unit.raw.faction_id}/${unit.id}`)}
            <option value={unit.id}>
              {unit.name}{sharedPartnerNames.has(unit.name)
                ? ` · ${unit.faction?.name ?? unit.raw.faction_id}`
                : ""}
            </option>
          {/each}
        </optgroup>
      {/if}
    </select>
  </div>
{/if}

<div class="row">
  <label>Phase</label>
  <div class="tabs">
    {#each PHASE_CHOICES as p (p)}
      <button class:active={salvo.phase === p} onclick={() => (salvo.phase = p)}>{p}</button>
    {/each}
  </div>
</div>

{#if selectedUnit}
  {#if weapons.length === 0}
    <EmptyState>No {salvo.phase}-phase weapons for {selectedUnit.name}.</EmptyState>
  {/if}
{:else}
  <EmptyState>Pick a faction + unit, or import a roster.</EmptyState>
{/if}
