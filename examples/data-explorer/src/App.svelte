<script lang="ts">
  import { units } from "@alpaca-software/40kdc-data";
  import AppHeader from "../../_shared/AppHeader.svelte";
  import AppFooter from "../../_shared/AppFooter.svelte";
  import { LIST_BUILDER_URL, SALVO_URL } from "../../_shared/links.js";
  import { explorer, sortedFactions } from "./lib/store.svelte.js";
  import Datacard from "./lib/datacard.svelte";
  import Detachments from "./lib/detachments.svelte";
  import Roundtrip from "./lib/roundtrip.svelte";

  // Units of the selected faction, name-filtered, sorted.
  const factionUnits = $derived(
    explorer.factionId
      ? [...units.byFaction(explorer.factionId)].sort((a, b) =>
          a.name.localeCompare(b.name),
        )
      : [],
  );
  const filteredUnits = $derived(
    explorer.unitFilter.trim()
      ? factionUnits.filter((u) =>
          u.name.toLowerCase().includes(explorer.unitFilter.trim().toLowerCase()),
        )
      : factionUnits,
  );

  const selectedUnit = $derived(
    explorer.unitId ? units.get(explorer.unitId) : undefined,
  );

  // Keep a unit selected as the faction changes.
  $effect(() => {
    const ids = new Set(factionUnits.map((u) => u.id));
    if (!explorer.unitId || !ids.has(explorer.unitId)) {
      explorer.unitId = factionUnits[0]?.id ?? null;
    }
  });

  function pts(u: (typeof factionUnits)[number]): string {
    const tiers = u.raw.points;
    if (!tiers || tiers.length === 0) return "";
    const cheapest = Math.min(...tiers.map((t) => t.cost));
    return `${cheapest}`;
  }

  // Picking a unit in Roundtrip also narrows the collation scope to that unit.
  function selectUnit(id: string): void {
    explorer.unitId = id;
    if (explorer.view === "roundtrip") explorer.roundtripAll = false;
  }

  // A unit row is highlighted in Browse whenever it's the selected unit; in
  // Roundtrip only when the collation is scoped to that unit (not "all").
  function unitActive(id: string): boolean {
    return explorer.view === "roundtrip"
      ? !explorer.roundtripAll && id === explorer.unitId
      : id === explorer.unitId;
  }
</script>

<div class="app">
  <AppHeader title="Data Explorer" tag="dataset browser" appId="data-explorer" />

  <nav class="view-tabs">
    <button class:active={explorer.view === "browse"} onclick={() => (explorer.view = "browse")}>Browse</button>
    <button class:active={explorer.view === "roundtrip"} onclick={() => (explorer.view = "roundtrip")}>Roundtrip QA</button>
  </nav>

  <aside class="sidebar">
    <div class="section-label">Faction</div>
    <select bind:value={explorer.factionId}>
      {#each sortedFactions as f (f.id)}
        <option value={f.id}>{f.name}</option>
      {/each}
    </select>

    <div class="section-label">Unit</div>
    <input placeholder="Filter units…" bind:value={explorer.unitFilter} />
    <div class="unit-list">
      {#if explorer.view === "roundtrip"}
        <button
          class="collation-all"
          class:active={explorer.roundtripAll}
          onclick={() => (explorer.roundtripAll = true)}
        >
          <span>✦ All faction abilities</span>
        </button>
      {/if}
      {#each filteredUnits as u (u.id)}
        <button class:active={unitActive(u.id)} onclick={() => selectUnit(u.id)}>
          <span>{u.name}</span>
          {#if pts(u)}<span class="pts">{pts(u)}</span>{/if}
        </button>
      {/each}
      {#if filteredUnits.length === 0}
        <p class="dim" style="font-size:var(--text-xs);padding:var(--space-2)">No units match.</p>
      {/if}
    </div>

    {#if explorer.view === "roundtrip"}
      <div class="section-label">Ability filter</div>
      <input placeholder="Filter abilities by name or id…" bind:value={explorer.abilitySearch} />
    {/if}
  </aside>

  <section class="main">
    {#if explorer.view === "browse"}
      {#if selectedUnit}
        <Datacard unit={selectedUnit} />
      {:else}
        <div class="empty-state">Pick a faction and unit to see its datacard.</div>
      {/if}
      {#if explorer.factionId}
        <Detachments factionId={explorer.factionId} />
      {/if}
    {:else}
      <Roundtrip />
    {/if}
  </section>

  <AppFooter
    links={[
      { label: "Salvo", href: SALVO_URL },
      { label: "List Builder", href: LIST_BUILDER_URL },
    ]}
    version={__DATA_VERSION__}
    build={__BUILD_SHA__}
  />
</div>
