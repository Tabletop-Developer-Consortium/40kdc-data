<script lang="ts">
  import type { GraphStore, GraphFilters, GraphScope } from "./graph-store.svelte.js";
  import { edgeKindLabel, nodeKindLabel } from "./graph-presentation.js";

  let { store }: { store: GraphStore } = $props();

  interface CountOption {
    value: string;
    label: string;
    count: number;
  }
  type FilterArrayKey = "nodeKinds" | "states" | "validities" | "edgeKinds";
  interface FilterGroup {
    key: FilterArrayKey;
    label: string;
    options: CountOption[];
  }

  const nodeKindOptions = $derived.by((): CountOption[] => {
    const counts = new Map<string, number>();
    for (const node of store.nodes.values()) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) => ({
      value,
      label: nodeKindLabel(value),
      count,
    }));
  });

  const stateOptions = $derived.by((): CountOption[] => {
    const counts = new Map<string, number>();
    for (const node of store.nodes.values()) {
      const value = node.state ?? "unrecorded";
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) => ({
      value,
      label: value.replaceAll("_", " "),
      count,
    }));
  });

  const validityOptions = $derived.by((): CountOption[] => {
    const counts = new Map<string, number>();
    for (const node of store.nodes.values()) {
      const value = node.validity ?? "unrecorded";
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) => ({
      value,
      label: value.replaceAll("_", " "),
      count,
    }));
  });

  const edgeKindOptions = $derived.by((): CountOption[] => {
    const counts = new Map<string, number>();
    for (const edge of store.edges.values()) counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
    return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) => ({
      value,
      label: edgeKindLabel(value),
      count,
    }));
  });
  const filterGroups = $derived<FilterGroup[]>([
    { key: "nodeKinds", label: "Node kind", options: nodeKindOptions },
    { key: "states", label: "State", options: stateOptions },
    { key: "validities", label: "Validity", options: validityOptions },
    { key: "edgeKinds", label: "Edge kind", options: edgeKindOptions },
  ]);


  const hasFilters = $derived(
    Boolean(
      store.filters.search ||
        store.filters.nodeKinds.length ||
        store.filters.states.length ||
        store.filters.validities.length ||
        store.filters.edgeKinds.length ||
        store.filters.collapseCertified,
    ),
  );

  function patch(patch: Partial<GraphFilters>): void {
    store.setFilters({ ...store.filters, ...patch });
  }

  function toggle(key: FilterArrayKey, value: string): void {
    const current = store.filters[key];
    patch({
      [key]: current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value],
    });
  }
</script>

<aside class="filter-rail" aria-label="Graph filters">
  <section>
    <label for="campaign">Campaign</label>
    <select
      id="campaign"
      value={store.campaign?.campaignId ?? ""}
      onchange={(event) => void store.selectCampaign(event.currentTarget.value)}
    >
      {#each store.campaigns as campaign (campaign.campaignId)}
        <option value={campaign.campaignId}>{campaign.campaignId} · {campaign.state}</option>
      {/each}
    </select>

    <label for="scope">Graph scope</label>
    <select
      id="scope"
      value={store.graphScope}
      onchange={(event) => void store.setGraphScope(event.currentTarget.value as GraphScope)}
    >
      <option value="trace">Focused trace</option>
      <option value="overview">Whole campaign overview</option>
    </select>
  </section>

  <section>
    <label for="graph-search">Safe label or ID</label>
    <input
      id="graph-search"
      type="search"
      value={store.filters.search}
      placeholder="Find node"
      oninput={(event) => patch({ search: event.currentTarget.value })}
    />
    <label class="check-line">
      <input
        type="checkbox"
        checked={store.filters.collapseCertified}
        onchange={(event) => patch({ collapseCertified: event.currentTarget.checked })}
      />
      Collapse certified subgraph
    </label>
  </section>

  {#each filterGroups as group (group.key)}
    <details>
      <summary>
        <span>{group.label}</span>
        <span>{store.filters[group.key].length || group.options.length}</span>
      </summary>
      <div class="option-list">
        {#each group.options as option (option.value)}
          <label>
            <input
              type="checkbox"
              checked={store.filters[group.key].includes(option.value)}
              onchange={() => toggle(group.key, option.value)}
            />
            <span>{option.label}</span>
            <span class="count">{option.count}</span>
          </label>
        {/each}
      </div>
    </details>
  {/each}

  <div class="rail-actions">
    <button type="button" onclick={() => store.requestFit()}>Fit current view</button>
    <button type="button" onclick={() => store.resetLayout()}>Reset layout</button>
    <button type="button" disabled={!hasFilters} onclick={() => store.resetFilters()}>Reset filters</button>
  </div>
</aside>

<style>
  .filter-rail {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    border-right: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--muted);
    font-size: var(--text-xs);
  }

  section,
  details,
  .rail-actions {
    padding: var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  section {
    display: grid;
    gap: 6px;
  }

  label:not(.check-line),
  summary {
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  select,
  input[type="search"] {
    width: 100%;
  }

  .check-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: 3px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  details {
    padding-block: var(--space-2);
  }

  summary {
    display: flex;
    justify-content: space-between;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::before {
    content: "›";
    margin-right: 6px;
    color: var(--dim);
    transition: transform 160ms ease-out;
  }

  details[open] summary::before {
    transform: rotate(90deg);
  }

  summary span:first-of-type {
    flex: 1;
  }

  .option-list {
    display: grid;
    gap: 4px;
    padding-top: var(--space-2);
  }

  .option-list label {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-family: var(--font-body);
    font-size: var(--text-xs);
    letter-spacing: 0;
    text-transform: none;
  }

  .option-list span:not(.count) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    color: var(--dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
  }

  .rail-actions {
    display: grid;
    gap: 6px;
  }

  @media (prefers-reduced-motion: reduce) {
    summary::before {
      transition: none;
    }
  }
</style>
