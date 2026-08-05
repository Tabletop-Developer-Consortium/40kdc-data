<script lang="ts">
  import { onMount } from "svelte";
  import AppFooter from "../../_shared/AppFooter.svelte";
  import AppHeader from "../../_shared/AppHeader.svelte";
  import { createMechanicGraphClient } from "./lib/api/client.js";
  import GraphCanvas from "./lib/GraphCanvas.svelte";
  import { createGraphStore } from "./lib/graph-store.svelte.js";

  const client = createMechanicGraphClient();
  const store = createGraphStore(client);

  onMount(() => {
    const resize = () => store.setViewportWidth(window.innerWidth);
    resize();
    window.addEventListener("resize", resize);
    void store.start();
    return () => {
      window.removeEventListener("resize", resize);
      store.stop();
    };
  });

  function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  }
</script>

<svelte:head><title>Mechanic Evidence Graph</title></svelte:head>

<div class="app-shell">
  <AppHeader title="Evidence Graph" tag="global mechanic lineage">
    {#snippet nav()}
      <span class="local-only">127.0.0.1 · LOCAL ONLY</span>
      <code data-testid="rendered-count">{store.renderedNodeCount} / 400 nodes</code>
    {/snippet}
  </AppHeader>

  <section class="summary-strip" aria-label="Graph summary">
    <div><strong>{store.abilityIndex.length}</strong><span>loaded abilities</span></div>
    <div><strong>{store.filteredAbilities.length}</strong><span>matching filters</span></div>
    <div><strong>{store.selectedAbility ? store.renderedNodeCount : 0}</strong><span>rendered evidence nodes</span></div>
    <div class:warning={store.truncated}><strong>{store.truncated ? "bounded" : "complete"}</strong><span>current page</span></div>
    <div class:warning={store.connection !== "live"}><strong>{store.connection}</strong><span>connection</span></div>
  </section>

  {#if store.diagnostic}
    <div class="diagnostic" class:danger={store.connection === "error" || store.connection === "stale"} role="status">
      <span>{store.diagnostic}</span>
      <button type="button" onclick={() => void store.retry()}>Retry</button>
    </div>
  {/if}

  <main class="workspace">
    <aside class="ability-browser" aria-label="Ability index">
      <header>
        <span>GLOBAL INDEX</span>
        <h2>Abilities</h2>
        <p>Choose one ability to replace the canvas with its bounded evidence view.</p>
      </header>
      <label>
        <span>Search</span>
        <input
          type="search"
          value={store.search}
          placeholder="Ability, faction, or ID"
          oninput={(event) => store.setSearch(event.currentTarget.value)}
        />
      </label>
      <div class="filter-row">
        <label>
          <span>Faction</span>
          <select value={store.factionFilter} onchange={(event) => store.setFactionFilter(event.currentTarget.value)}>
            <option value="">All factions</option>
            {#each store.factions as faction}<option value={faction}>{faction}</option>{/each}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select value={store.statusFilter} onchange={(event) => store.setStatusFilter(event.currentTarget.value)}>
            <option value="">All statuses</option>
            {#each store.statuses as status}<option value={status}>{status}</option>{/each}
          </select>
        </label>
      </div>

      {#if store.connection === "loading" && store.abilityIndex.length === 0}
        <div class="list-state" aria-live="polite">Loading bounded ability index…</div>
      {:else if store.connection === "error" && store.abilityIndex.length === 0}
        <div class="list-state error">The ability index could not be loaded.</div>
      {:else if store.filteredAbilities.length === 0}
        <div class="list-state">No abilities match these filters.</div>
      {:else}
        <div class="ability-list">
          {#each store.filteredAbilities as ability (ability.id)}
            <button
              type="button"
              class:selected={store.selectedAbility?.id === ability.id}
              onclick={() => void store.selectAbility(ability)}
            >
              <strong>{ability.label}</strong>
              <span>{ability.metadata.evidence_count ?? 0} evidence nodes · {strings(ability.metadata.statuses).join(", ") || "unrecorded"}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if store.nextCursor && !store.selectedAbility}
        <button class="load-more" type="button" disabled={store.loadingMore} onclick={() => void store.loadMoreIndex()}>
          {store.loadingMore ? "Loading…" : "Load next 100 abilities"}
        </button>
      {/if}
    </aside>

    <section class="canvas-panel" aria-label="Selected ability evidence">
      <header class="canvas-toolbar">
        <div>
          <span>SELECTED VIEW</span>
          <h2>{store.selectedAbility?.label ?? "Select an ability"}</h2>
        </div>
        <div class="toolbar-actions">
          {#if store.selectedAbility}<button type="button" onclick={() => store.resetLayout()}>Reset layout</button>{/if}
          {#if store.nextCursor && store.selectedAbility}
            <button type="button" disabled={store.loadingMore || store.renderedNodeCount >= 400} onclick={() => void store.loadMoreEvidence()}>
              {store.loadingMore ? "Loading…" : "Load more evidence"}
            </button>
          {/if}
        </div>
      </header>
      {#if store.connection === "loading" && store.selectedAbility}
        <div class="canvas-state" aria-live="polite">Loading evidence and replacing the previous view…</div>
      {:else if !store.selectedAbility}
        <div class="canvas-state"><strong>No ability selected</strong><span>The initial request loads index metadata only—no evidence descendants.</span></div>
      {:else if store.nodes.size === 0}
        <div class="canvas-state"><strong>No evidence in this bounded view</strong><span>Retry or choose another ability.</span></div>
      {:else}
        <GraphCanvas {store} />
      {/if}
      {#if store.truncated && store.selectedAbility}
        <div class="truncation" role="status">This view is truncated. Expand one page at a time; the 400-node cap stays enforced.</div>
      {/if}
    </section>

    <aside class="inspector" aria-label="Evidence details">
      <header><span>SAFE DETAIL</span><h2>{store.selectedNode?.label ?? "No node selected"}</h2></header>
      {#if store.selectedNode}
        {@const node = store.selectedNode}
        <dl>
          <dt>Kind</dt><dd>{node.kind}</dd>
          <dt>Scope</dt><dd>{node.scope}</dd>
          <dt>Campaigns</dt><dd>{node.campaign_refs.join(", ") || "global"}</dd>
          <dt>Runs</dt><dd>{strings(node.metadata.run_ids).join(", ") || "none"}</dd>
          <dt>Statuses</dt><dd>{strings(node.metadata.statuses).join(", ") || "unrecorded"}</dd>
          <dt>Certificates</dt><dd>{strings(node.metadata.certificates).join(", ") || "none"}</dd>
          <dt>Findings</dt><dd>{strings(node.metadata.findings).join(", ") || "none"}</dd>
        </dl>
        <section class="refs">
          <h3>Ability references</h3>
          {#if node.ability_refs.length}
            {#each node.ability_refs as reference}
              <div><strong>{reference.label}</strong><span>{reference.source_kind} · distance {reference.distance} · {reference.metadata_status}</span></div>
            {/each}
          {:else}<p>Global node; no ability owner.</p>{/if}
        </section>
        {#if store.isBranch(node)}
          <button class="branch-toggle" type="button" onclick={() => store.toggleBranch(node.id)}>
            {store.isBranchExpanded(node.id) ? "Collapse branch" : "Expand branch"}
          </button>
        {/if}
      {:else}
        <p class="inspector-empty">Select a rendered node. Arbitrary payload fields and source prose are never shown.</p>
      {/if}
    </aside>
  </main>

  <AppFooter />
</div>

<style>
  .app-shell { min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); }
  .local-only, header > span, .canvas-toolbar span { font: 600 0.66rem/1.2 var(--mono); letter-spacing: .12em; color: var(--muted); }
  .summary-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-block: 1px solid var(--border); background: var(--panel); }
  .summary-strip div { display: flex; gap: .45rem; align-items: baseline; padding: .55rem .8rem; border-right: 1px solid var(--border); }
  .summary-strip strong { font-family: var(--mono); } .summary-strip span { color: var(--muted); font-size: .72rem; }
  .warning strong { color: var(--warning); }
  .diagnostic { display:flex; justify-content:space-between; align-items:center; padding:.55rem .8rem; background:var(--panel-2); border-bottom:1px solid var(--border); }
  .diagnostic.danger { color: var(--danger); }
  button, input, select { font: inherit; }
  button { color: inherit; }
  .workspace { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(250px, 310px) minmax(0, 1fr) minmax(280px, 360px); }
  .ability-browser, .inspector { min-height: 0; padding: 1rem; background: var(--panel); overflow: auto; }
  .ability-browser { border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: .8rem; }
  .inspector { border-left: 1px solid var(--border); }
  h2 { margin: .15rem 0; font-size: 1rem; } h3 { font-size: .76rem; text-transform: uppercase; letter-spacing: .08em; }
  p { color: var(--muted); font-size: .78rem; line-height: 1.5; }
  label { display: grid; gap: .3rem; min-width: 0; } label > span { font-size: .68rem; color: var(--muted); }
  input, select { width: 100%; min-width: 0; padding: .52rem; color: var(--text); background: var(--panel-2); border: 1px solid var(--border-strong); }
  .filter-row { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
  .ability-list { min-height: 0; display: grid; gap: .35rem; overflow: auto; }
  .ability-list button { display: grid; gap: .3rem; text-align: left; padding: .65rem; background: transparent; border: 1px solid var(--border); cursor: pointer; }
  .ability-list button:hover, .ability-list button.selected { border-color: var(--accent); background: var(--panel-2); }
  .ability-list strong { font-size: .76rem; line-height: 1.35; } .ability-list span { color: var(--muted); font: .63rem/1.35 var(--mono); }
  .load-more, .toolbar-actions button, .diagnostic button, .branch-toggle { padding: .45rem .7rem; background: var(--panel-2); border: 1px solid var(--border-strong); cursor: pointer; }
  .canvas-panel { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; position: relative; }
  .canvas-toolbar { display: flex; justify-content: space-between; gap: 1rem; align-items: center; padding: .65rem .8rem; background: var(--panel); border-bottom: 1px solid var(--border); }
  .toolbar-actions { display: flex; gap: .45rem; }
  .canvas-state { display: grid; place-content: center; gap: .45rem; text-align: center; color: var(--muted); }
  .canvas-state strong { color: var(--text); }
  .truncation { padding: .4rem .7rem; color: var(--warning); background: var(--panel); border-top: 1px solid var(--border); font-size: .72rem; }
  .list-state { padding: 1rem; color: var(--muted); border: 1px dashed var(--border); } .list-state.error { color: var(--danger); }
  .inspector dl { display: grid; grid-template-columns: 88px 1fr; gap: .45rem; margin: 1rem 0; font-size: .72rem; }
  .inspector dt { color: var(--muted); } .inspector dd { margin: 0; overflow-wrap: anywhere; font-family: var(--mono); }
  .refs { border-top: 1px solid var(--border); padding-top: .7rem; }
  .refs div { display: grid; gap: .25rem; padding: .5rem 0; border-bottom: 1px solid var(--border); }
  .refs strong { font-size: .72rem; } .refs span { color: var(--muted); font: .62rem/1.4 var(--mono); }
  @media (max-width: 980px) { .workspace { grid-template-columns: 240px minmax(0,1fr); } .inspector { display:none; } .summary-strip { grid-template-columns: repeat(3,1fr); } }
  @media (max-width: 680px) { .workspace { grid-template-columns: 1fr; grid-template-rows: 280px minmax(500px,1fr); } .ability-browser { border-right:0; border-bottom:1px solid var(--border); } .summary-strip { grid-template-columns: 1fr 1fr; } }
</style>
