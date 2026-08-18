<script lang="ts">
  import { onMount } from "svelte";
  import AppFooter from "../../_shared/AppFooter.svelte";
  import AppHeader from "../../_shared/AppHeader.svelte";
  import { createMechanicGraphClient } from "./lib/api/client.js";
  import GraphCanvas from "./lib/GraphCanvas.svelte";
  import { createGraphStore } from "./lib/graph-store.svelte.js";
  import type { ProjectionNode } from "./lib/api/types.js";
  import {
    edgeKindLabel,
    edgeRelationshipDescription,
    nodeKindLabel,
    workflowRoleLabel,
  } from "./lib/graph-presentation.js";

  const client = createMechanicGraphClient();
  const store = createGraphStore(client);
  let graphNodeQuery = $state("");

  $effect(() => {
    store.projectionNodeCount;
    store.setGraphSearch(graphNodeQuery);
  });

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

  function countState(states: Record<string, number>, state: string): number {
    return states[state] ?? 0;
  }

  function nonzeroStates(states: Record<string, number>, excludedState?: string): string {
    return Object.entries(states)
      .filter(([state, count]) => state !== excludedState && count > 0)
      .map(([state, count]) => `${state} ${count}`)
      .join(" · ");
  }

  function projectionLabel(node: ProjectionNode): string {
    return typeof node.metadata.output_kind === "string"
      ? workflowRoleLabel(node.metadata.output_kind)
      : node.label;
  }

  function projectionContext(node: ProjectionNode): string {
    const parts = [
      node.metadata.workflow_task,
      node.metadata.workflow_lane,
      typeof node.metadata.attempt_number === "number" ? `attempt ${node.metadata.attempt_number}` : null,
    ];
    return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
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
    <div><strong>{store.selectedAbility || store.activeCampaignGraphId ? store.renderedNodeCount : 0}</strong><span>rendered evidence nodes</span></div>
    <div class:warning={store.truncated}><strong>{store.truncated ? "bounded" : "complete"}</strong><span>current page</span></div>
    <div class:warning={store.connection !== "live"}><strong>{store.connection}</strong><span>connection</span></div>
  </section>

  {#if store.diagnostic}
    <div class="diagnostic" class:danger={store.connection === "error" || store.connection === "stale"} role="status">
      <span>{store.diagnostic}</span>
      <button type="button" onclick={() => void store.retry()}>Retry</button>
    </div>
  {/if}

  <section class="campaign-progress" aria-label="Campaign progress">
    <div class="campaign-progress-heading">
      <strong>Campaign progress</strong>
      {#if store.campaignProgressStatus === "loading"}
        <span aria-live="polite">Loading campaign context…</span>
      {:else if store.campaignProgressStatus === "error"}
        <span class="campaign-error" role="status">{store.campaignProgressDiagnostic ?? "Campaign progress could not be loaded."}</span>
        <button type="button" onclick={() => void store.retry()}>Retry</button>
      {:else if store.campaignProgress.length === 0}
        <span>No campaign progress is available.</span>
      {:else}
        <label>
          <span>Campaign</span>
          <select
            value={store.selectedCampaignProgressId ?? ""}
            aria-label="Campaign progress context"
            onchange={(event) => store.selectCampaignProgress(event.currentTarget.value)}
          >
            {#each store.campaignProgress as campaign (campaign.campaignId)}
              <option value={campaign.campaignId}>{campaign.runId === campaign.campaignId ? campaign.campaignId : `${campaign.runId} · ${campaign.campaignId}`}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>

    {#if store.campaignProgressStatus === "ready" && store.selectedCampaignProgress}
      {@const campaign = store.selectedCampaignProgress}
      {@const succeededTasks = countState(campaign.taskStates, "succeeded")}
      <div class="campaign-progress-details">
        <span><b>{campaign.state}</b> · {campaign.kind ?? "unrecorded"} · {campaign.target ?? "unrecorded"}</span>
        <span class="campaign-task-progress">
          <progress value={succeededTasks} max={Math.max(campaign.taskTotal, 1)} aria-label="Succeeded tasks"></progress>
          <b>{succeededTasks} / {campaign.taskTotal} succeeded</b>
        </span>
        <span>{nonzeroStates(campaign.taskStates, "succeeded") || "No other task states"}</span>
        <span>{countState(campaign.claimStates, "active")} active claims</span>
        <span>{countState(campaign.findingStates, "open")} open findings</span>
        <span>{countState(campaign.checkStates, "passed")} passed checks</span>
        {#if store.activeCampaignGraphId === campaign.campaignId}
          {#if store.selectedAbility}
            <button type="button" onclick={() => void store.selectCampaign(campaign.campaignId)}>Back to campaign graph</button>
          {/if}
          <button type="button" onclick={() => void store.showGlobalGraph()}>Return to global graph</button>
        {:else}
          <button type="button" onclick={() => void store.selectCampaign(campaign.campaignId)}>View campaign graph</button>
        {/if}
      </div>
    {/if}
  </section>

  <main class="workspace">
    <aside class="ability-browser" aria-label="Ability index">
      <header>
        <span>{store.activeCampaignGraphId ? "CAMPAIGN INDEX" : "GLOBAL INDEX"}</span>
        <h2>{store.activeCampaignGraphId ?? "Abilities"}</h2>
        <p>{store.activeCampaignGraphId ? "Choose an ability to drill into its complete bounded evidence view." : "Choose one ability to replace the canvas with its bounded evidence view."}</p>
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
      {#if store.nextCursor && !store.selectedAbility && !store.activeCampaignGraphId}
        <button class="load-more" type="button" disabled={store.loadingMore} onclick={() => void store.loadMoreIndex()}>
          {store.loadingMore ? "Loading…" : "Load next 100 abilities"}
        </button>
      {/if}
    </aside>

    <section class="canvas-panel" aria-label={store.activeCampaignGraphId && !store.selectedAbility ? "Campaign evidence graph" : "Selected ability evidence"}>
      <header class="canvas-toolbar">
        <div>
          <span>{store.graphScope === "trace" ? "FOCUSED TRACE" : "CAMPAIGN OVERVIEW"}</span>
          <h2>{store.selectedAbility?.label ?? store.activeCampaignGraphId ?? "Select an ability"}</h2>
        </div>
        <div class="toolbar-actions">
          {#if store.selectedAbility || store.activeCampaignGraphId}
            <div class="view-switch" aria-label="Graph view">
              <button type="button" class:active={store.graphScope === "trace"} aria-pressed={store.graphScope === "trace"} onclick={() => store.setGraphScope("trace")}>Trace</button>
              <button type="button" class:active={store.graphScope === "overview"} aria-pressed={store.graphScope === "overview"} onclick={() => store.setGraphScope("overview")}>Overview · {store.projectionNodeCount}</button>
            </div>
            <button type="button" onclick={() => store.resetLayout()}>Reset layout</button>
          {/if}
          {#if store.nextCursor && (store.selectedAbility || store.activeCampaignGraphId)}
            <button type="button" disabled={store.loadingMore || store.projectionNodeCount >= 400} onclick={() => void store.loadMoreEvidence()}>
              {store.loadingMore ? "Loading…" : "Load more evidence"}
            </button>
          {/if}
        </div>
      </header>

      {#if store.selectedAbility || store.activeCampaignGraphId}
        <div class="trace-tools">
          <p><strong>Inputs → dependents.</strong> Columns are computed from relationships, not importance.</p>
          <div class="graph-search">
            <label for="graph-node-search">Find node</label>
            <input
              id="graph-node-search"
              type="search"
              bind:value={graphNodeQuery}
              placeholder="Role, stage, task, or hash"
              autocomplete="off"
            />
            {#if graphNodeQuery.trim()}
              <div class="graph-search-results" aria-live="polite">
                {#if store.graphSearchResults.length}
                  {#each store.graphSearchResults as node (node.id)}
                    <button type="button" onclick={() => { graphNodeQuery = ""; store.focusTraceNode(node.id); }}>
                      <strong>{projectionLabel(node)}</strong>
                      <span>{projectionContext(node) || nodeKindLabel(node.kind.replaceAll("-", "_"))} · {node.id.slice(0, 12)}</span>
                    </button>
                  {/each}
                {:else}
                  <p>No graph nodes match.</p>
                {/if}
              </div>
            {/if}
          </div>
        </div>
        {#if store.graphScope === "trace" && store.traceBreadcrumbs.length}
          <nav class="trace-breadcrumbs" aria-label="Trace lineage">
            {#each store.traceBreadcrumbs as node, index (node.id)}
              {#if index > 0}<span aria-hidden="true">›</span>{/if}
              <button type="button" aria-current={node.id === store.traceAnchorId ? "location" : undefined} onclick={() => store.focusTraceNode(node.id)}>
                {projectionLabel(node)}
              </button>
            {/each}
          </nav>
        {/if}
      {/if}

      {#if store.connection === "loading" && (store.selectedAbility || store.activeCampaignGraphId)}
        <div class="canvas-state" aria-live="polite">Loading bounded evidence and replacing the previous view…</div>
      {:else if !store.selectedAbility && !store.activeCampaignGraphId}
        <div class="canvas-state"><strong>No ability selected</strong><span>The initial request loads index metadata only, with no evidence descendants.</span></div>
      {:else if store.connection === "error" || (store.connection === "stale" && store.nodes.size === 0)}
        <div class="canvas-state"><strong>Evidence view unavailable</strong><span>The evidence view could not be loaded. Use the top Retry action to reload it.</span></div>
      {:else if store.nodes.size === 0}
        <div class="canvas-state"><strong>No evidence in this bounded view</strong><span>Retry or choose another ability.</span></div>
      {:else}
        <GraphCanvas {store} />
      {/if}
      {#if store.traceHiddenSuccessorCount > 0 && store.graphScope === "trace"}
        <div class="truncation" role="status">Showing the first 12 direct dependents. Inspect the selected node for {store.traceHiddenSuccessorCount} more.</div>
      {:else if store.truncated && (store.selectedAbility || store.activeCampaignGraphId)}
        <div class="truncation" role="status">This view is truncated. Load one page at a time; the 400-node cap stays enforced.</div>
      {/if}
    </section>

    <aside class="inspector" aria-label="Evidence details">
      <header>
        <span>{store.selectedEdge ? "RELATIONSHIP" : "SAFE DETAIL"}</span>
        <h2>{store.selectedEdge ? edgeKindLabel(store.selectedEdge.kind) : store.selectedNode ? projectionLabel(store.selectedNode) : "No selection"}</h2>
      </header>
      {#if store.selectedEdge && store.selectedEdgeSource && store.selectedEdgeTarget}
        <p class="relationship-summary">
          {edgeRelationshipDescription(store.selectedEdge, projectionLabel(store.selectedEdgeSource), projectionLabel(store.selectedEdgeTarget))}
        </p>
        <dl>
          <dt>Kind</dt><dd>{edgeKindLabel(store.selectedEdge.kind)}</dd>
          <dt>Direction</dt><dd>{store.selectedEdge.sourceNodeId.slice(0, 12)} → {store.selectedEdge.targetNodeId.slice(0, 12)}</dd>
          <dt>Authority</dt><dd>{store.selectedEdge.authority}</dd>
          <dt>Other inputs</dt><dd>{store.selectedEdgeOtherInputCount}</dd>
        </dl>
        <section class="relationship-endpoints">
          <h3>Endpoints</h3>
          <button type="button" onclick={() => store.focusTraceNode(store.selectedEdgeSource!.id)}>
            <span>Source</span><strong>{projectionLabel(store.selectedEdgeSource)}</strong><code>{store.selectedEdgeSource.id.slice(0, 12)}</code>
          </button>
          <button type="button" onclick={() => store.focusTraceNode(store.selectedEdgeTarget!.id)}>
            <span>Target</span><strong>{projectionLabel(store.selectedEdgeTarget)}</strong><code>{store.selectedEdgeTarget.id.slice(0, 12)}</code>
          </button>
        </section>
      {:else if store.selectedNode}
        {@const node = store.selectedNode}
        <dl>
          <dt>Kind</dt><dd>{nodeKindLabel(node.kind.replaceAll("-", "_"))}</dd>
          <dt>Output</dt><dd>{typeof node.metadata.output_kind === "string" ? node.metadata.output_kind : "not applicable"}</dd>
          <dt>Stage</dt><dd>{node.metadata.workflow_stage ?? "not recorded"}</dd>
          <dt>Task</dt><dd>{node.metadata.workflow_task ?? "not recorded"}</dd>
          <dt>Lane</dt><dd>{node.metadata.workflow_lane ?? "not recorded"}</dd>
          <dt>Round</dt><dd>{node.metadata.workflow_round ?? "not recorded"}</dd>
          <dt>Attempt</dt><dd>{node.metadata.attempt_number ?? "not recorded"}</dd>
          <dt>Lineage rank</dt><dd>{node.metadata.lineage_distance ?? "not recorded"}</dd>
          <dt>Scope</dt><dd>{node.scope}</dd>
          <dt>Campaigns</dt><dd>{node.campaign_refs.join(", ") || "global"}</dd>
          <dt>Node hash</dt><dd>{node.id}</dd>
          <dt>Task ID</dt><dd>{node.metadata.task_id ?? "not recorded"}</dd>
          <dt>Attempt ID</dt><dd>{node.metadata.attempt_id ?? "not recorded"}</dd>
        </dl>
        <p class="rank-note">Lineage rank records projected distance. The layout column follows dependencies and does not encode importance.</p>
        <section class="relationships">
          <h3>Inputs · {store.incomingRelationships.length}</h3>
          {#if store.incomingRelationships.length}
            {#each store.incomingRelationships as relationship (relationship.edge.edgeId)}
              <button type="button" onclick={() => store.focusTraceNode(relationship.node.id)}>
                <span>{edgeKindLabel(relationship.edge.kind)}</span>
                <strong>{projectionLabel(relationship.node)}</strong>
                <code>{relationship.node.id.slice(0, 12)}</code>
              </button>
            {/each}
          {:else}<p>No recorded inputs.</p>{/if}
        </section>
        <section class="relationships">
          <h3>Dependents · {store.outgoingRelationships.length}</h3>
          {#if store.outgoingRelationships.length}
            {#each store.outgoingRelationships as relationship (relationship.edge.edgeId)}
              <button type="button" onclick={() => store.focusTraceNode(relationship.node.id)}>
                <span>{edgeKindLabel(relationship.edge.kind)}</span>
                <strong>{projectionLabel(relationship.node)}</strong>
                <code>{relationship.node.id.slice(0, 12)}</code>
              </button>
            {/each}
          {:else}<p>No recorded dependents.</p>{/if}
        </section>
        <section class="refs">
          <h3>Ability references</h3>
          {#if node.ability_refs.length}
            {#each node.ability_refs as reference}
              <div><strong>{reference.label}</strong><span>{reference.source_kind} · distance {reference.distance} · {reference.metadata_status}</span></div>
            {/each}
          {:else}<p>Global node; no ability owner.</p>{/if}
        </section>
      {:else}
        <p class="inspector-empty">Select a node or relationship. Arbitrary payload fields and source prose are never shown.</p>
      {/if}
    </aside>
  </main>

  <AppFooter />
</div>

<style>
  .app-shell { min-height: 100vh; display: flex; flex-direction: column; container-type: inline-size; background: var(--bg); color: var(--text); }
  .local-only, header > span, .canvas-toolbar span { font: 600 0.66rem/1.2 var(--mono); letter-spacing: .12em; color: var(--muted); }
  .summary-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-block: 1px solid var(--border); background: var(--panel); }
  .summary-strip div { display: flex; gap: .45rem; align-items: baseline; padding: .55rem .8rem; border-right: 1px solid var(--border); }
  .summary-strip strong { font-family: var(--mono); } .summary-strip span { color: var(--muted); font-size: .72rem; }
  .warning strong { color: var(--warning); }
  .diagnostic { display:flex; justify-content:space-between; align-items:center; padding:.55rem .8rem; background:var(--panel-2); border-bottom:1px solid var(--border); }
  .diagnostic.danger { color: var(--danger); }
  .campaign-progress {
    display: grid;
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
    gap: .55rem 1rem;
    align-items: center;
    padding: .55rem .8rem;
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
    font-size: .72rem;
  }
  .campaign-progress-heading { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .7rem; min-width: 0; }
  .campaign-progress-heading > strong { font: 600 .7rem/1.2 var(--mono); letter-spacing: .08em; }
  .campaign-progress-heading > span { color: var(--muted); }
  .campaign-progress-heading .campaign-error { color: var(--danger); }
  .campaign-progress label { display: flex; align-items: center; gap: .35rem; min-width: 0; flex: 1 1 11rem; }
  .campaign-progress label > span { white-space: nowrap; }
  .campaign-progress select { padding: .35rem .45rem; font-size: .72rem; }
  .campaign-progress-details { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .8rem; min-width: 0; color: var(--muted); }
  .campaign-progress-details > span { min-width: 0; overflow-wrap: anywhere; }
  .campaign-progress-details b { color: var(--text); font-family: var(--mono); font-weight: 600; }
  .campaign-task-progress { display: inline-flex; align-items: center; gap: .35rem; white-space: nowrap; }
  .campaign-task-progress progress { inline-size: 4.5rem; block-size: .45rem; accent-color: var(--accent); }
  button, input, select { font: inherit; }
  button { color: inherit; }
  .workspace {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(15rem, 19rem) minmax(20rem, 1fr) minmax(17.5rem, 22.5rem);
  }
  .ability-browser, .inspector { min-height: 0; padding: 1rem; background: var(--panel); }
  .ability-browser {
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: .8rem;
    overflow: hidden;
  }
  .inspector { border-left: 1px solid var(--border); overflow: auto; }
  h2 { margin: .15rem 0; font-size: 1rem; } h3 { font-size: .76rem; text-transform: uppercase; letter-spacing: .08em; }
  p { color: var(--muted); font-size: .78rem; line-height: 1.5; }
  label { display: grid; gap: .3rem; min-width: 0; } label > span { font-size: .68rem; color: var(--muted); }
  input, select { width: 100%; min-width: 0; padding: .52rem; color: var(--text); background: var(--panel-2); border: 1px solid var(--border-strong); }
  .filter-row { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
  .ability-list {
    min-height: 0;
    flex: 1 1 auto;
    display: grid;
    grid-auto-rows: max-content;
    align-content: start;
    gap: .35rem;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .ability-list button {
    display: grid;
    align-self: start;
    block-size: max-content;
    min-width: 0;
    gap: .3rem;
    text-align: left;
    padding: .65rem;
    background: transparent;
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .ability-list button:hover, .ability-list button.selected { border-color: var(--accent); background: var(--panel-2); }
  .ability-list button.selected { border-color: var(--accent); }
  .ability-list strong, .ability-list span { overflow-wrap: anywhere; }
  .ability-list strong { font-size: .76rem; line-height: 1.35; } .ability-list span { color: var(--muted); font: .63rem/1.35 var(--mono); }
  .load-more, .toolbar-actions button, .diagnostic button, .campaign-progress button, .relationships button, .relationship-endpoints button {
    min-width: 32px;
    min-height: 32px;
    padding: .45rem .7rem;
    background: var(--panel-2);
    border: 1px solid var(--border-strong);
    cursor: pointer;
  }
  .app-shell :global(.app-header .links > a),
  .app-shell :global(.app-header .switch-trigger) {
    min-width: 32px;
    min-height: 32px;
  }
  .canvas-panel {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto auto auto minmax(0, 1fr) auto;
    position: relative;
  }
  .canvas-toolbar { display: flex; justify-content: space-between; gap: 1rem; align-items: center; padding: .65rem .8rem; background: var(--panel); border-bottom: 1px solid var(--border); }
  .canvas-toolbar > div:first-child { min-width: 0; }
  .canvas-toolbar h2 { overflow-wrap: anywhere; }
  .toolbar-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: .45rem; }
  .view-switch { display: inline-flex; }
  .view-switch button + button { margin-left: -1px; }
  .view-switch button.active { position: relative; z-index: 1; border-color: var(--accent); background: var(--accent-subtle); color: var(--text); }
  .trace-tools {
    position: relative;
    z-index: 8;
    display: grid;
    grid-template-columns: minmax(12rem, 1fr) minmax(13rem, 20rem);
    gap: .75rem;
    align-items: center;
    padding: .5rem .8rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
  }
  .trace-tools p { margin: 0; }
  .trace-tools p strong { color: var(--text); }
  .graph-search { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: .5rem; }
  .graph-search > label { color: var(--muted); font: 600 .62rem/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
  .graph-search input { padding: .4rem .5rem; font-size: .72rem; }
  .graph-search-results {
    position: absolute;
    top: calc(100% + .4rem);
    right: 0;
    width: min(28rem, calc(100vw - 2rem));
    max-height: 20rem;
    overflow: auto;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--panel);
    box-shadow: var(--shadow-md);
  }
  .graph-search-results button {
    display: grid;
    width: 100%;
    gap: .2rem;
    padding: .6rem .7rem;
    text-align: left;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    cursor: pointer;
  }
  .graph-search-results button:hover, .graph-search-results button:focus-visible { background: var(--panel-hover); }
  .graph-search-results strong { font-size: .72rem; }
  .graph-search-results span { color: var(--muted); font: .61rem/1.35 var(--mono); overflow-wrap: anywhere; }
  .graph-search-results p { margin: 0; padding: .75rem; }
  .trace-breadcrumbs {
    display: flex;
    min-width: 0;
    gap: .35rem;
    align-items: center;
    overflow-x: auto;
    padding: .42rem .8rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .trace-breadcrumbs span { color: var(--dim); }
  .trace-breadcrumbs button { flex: 0 0 auto; padding: .25rem .4rem; border: 1px solid transparent; background: transparent; color: var(--muted); font: .64rem/1.2 var(--mono); cursor: pointer; }
  .trace-breadcrumbs button:hover, .trace-breadcrumbs button[aria-current="location"] { border-color: var(--border-strong); color: var(--text); }
  .canvas-state { display: grid; place-content: center; gap: .45rem; text-align: center; color: var(--muted); }
  .canvas-state strong { color: var(--text); }
  .truncation { padding: .4rem .7rem; color: var(--warning); background: var(--panel); border-top: 1px solid var(--border); font-size: .72rem; }
  .list-state { padding: 1rem; color: var(--muted); border: 1px dashed var(--border); } .list-state.error { color: var(--danger); }
  .inspector dl { display: grid; grid-template-columns: 88px 1fr; gap: .45rem; margin: 1rem 0; font-size: .72rem; }
  .inspector h2, .refs strong, .refs span, .relationships strong, .relationship-endpoints strong { overflow-wrap: anywhere; }
  .inspector dt { color: var(--muted); } .inspector dd { margin: 0; overflow-wrap: anywhere; font-family: var(--mono); }
  .rank-note, .relationship-summary { padding: .65rem; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--panel-2); }
  .refs, .relationships, .relationship-endpoints { border-top: 1px solid var(--border); padding-top: .7rem; margin-top: .8rem; }
  .refs div { display: grid; gap: .25rem; padding: .5rem 0; border-bottom: 1px solid var(--border); }
  .refs strong { font-size: .72rem; } .refs span { color: var(--muted); font: .62rem/1.4 var(--mono); }
  .relationships, .relationship-endpoints { display: grid; gap: .4rem; }
  .relationships h3, .relationship-endpoints h3 { margin-block: 0 .25rem; }
  .relationships button, .relationship-endpoints button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: .2rem .5rem;
    text-align: left;
  }
  .relationships button span, .relationship-endpoints button span { grid-column: 1 / -1; color: var(--muted); font: .58rem/1.2 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
  .relationships button strong, .relationship-endpoints button strong { font-size: .7rem; }
  .relationships button code, .relationship-endpoints button code { color: var(--dim); font: .58rem/1.3 var(--mono); }
  @container (max-width: 72rem) {
    .workspace {
      grid-template-columns: minmax(15rem, 19rem) minmax(20rem, 1fr);
      grid-template-rows: minmax(0, 1fr) auto;
    }
    .inspector {
      grid-column: 1 / -1;
      max-block-size: 18rem;
      border-top: 1px solid var(--border);
      border-left: 0;
    }
    .summary-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .campaign-progress { grid-template-columns: 1fr; }
  }
  @container (max-width: 39rem) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 18rem minmax(38rem, 1fr) auto;
    }
    .ability-browser { border-right: 0; border-bottom: 1px solid var(--border); }
    .canvas-toolbar { align-items: flex-start; flex-direction: column; }
    .toolbar-actions { justify-content: flex-start; }
    .trace-tools { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
    .graph-search { grid-template-columns: minmax(0, 1fr); }
    .graph-search-results { right: auto; left: 0; }
    .inspector { grid-column: auto; max-block-size: none; }
    .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .campaign-progress label { flex-basis: 100%; }
  }
</style>
