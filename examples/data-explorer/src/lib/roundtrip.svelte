<script lang="ts">
  import { untrack } from "svelte";
  import { abilities, units } from "@alpaca-software/40kdc-data";
  import type { AbilityView } from "@alpaca-software/40kdc-data";
  import { explorer } from "./store.svelte.js";
  import { notes, fingerprintText } from "./notes.svelte.js";
  import { groupAbilities } from "../../../_shared/ability-groups.js";
  import {
    loadFactionIndex,
    entryKind,
    entryToText,
    type StoreIndex,
  } from "./source-store.js";
  import {
    parseReport,
    lookupScore,
    rankByVeracity,
    aggregateByShape,
  } from "./veracity-store.js";
  import { toJson, toMarkdown, download, type FlaggedRecord } from "./export.js";

  let index = $state<StoreIndex | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let sourceLabel = $state("");
  let count = $state(0);
  let specInput = $state(explorer.sourceSpec);
  let copyState = $state<"idle" | "json" | "error">("idle");
  let loadedFaction = $state<string | null>(null);

  // ── Embedding-veracity report ─────────────────────────────────────────────
  let veracityError = $state<string | null>(null);
  let reportInput = $state<HTMLInputElement | null>(null);

  function scoreFor(a: AbilityView): number | undefined {
    return lookupScore(
      explorer.veracity,
      (a.raw.faction_id as string | null | undefined) ?? null,
      explorer.factionId,
      a.id,
    );
  }

  function badgeClass(s: number): string {
    return s < 0.6 ? "weak" : s < 0.75 ? "mid" : "ok";
  }

  function fmt(n: number): string {
    return Number.isFinite(n) ? n.toFixed(2) : "—";
  }

  async function loadReport(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    veracityError = null;
    try {
      const idx = parseReport(JSON.parse(await file.text()));
      explorer.setVeracity(idx);
    } catch (err) {
      veracityError = err instanceof Error ? err.message : String(err);
      explorer.setVeracity(null);
    } finally {
      // Reset so re-picking the same file fires `change` again.
      if (reportInput) reportInput.value = "";
    }
  }

  function clearReport(): void {
    veracityError = null;
    explorer.setVeracity(null);
  }

  // ── Collation scope ─────────────────────────────────────────────────────
  // Whole-faction scope is the union of faction-scoped abilities and every
  // ability that appears on a unit of the faction — the latter picks up shared
  // `core` abilities, which carry no faction_id. Deduped by id, faction order
  // first; unit scope is just the selected unit's abilities.
  const scopeAbilities = $derived.by((): AbilityView[] => {
    if (!explorer.roundtripAll) {
      const u = explorer.unitId ? units.get(explorer.unitId) : undefined;
      return u?.abilities ?? [];
    }
    if (!explorer.factionId) return [];
    const seen = new Set<string>();
    const out: AbilityView[] = [];
    const push = (a: AbilityView): void => {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        out.push(a);
      }
    };
    for (const a of abilities.byFaction(explorer.factionId)) push(a);
    for (const u of units.byFaction(explorer.factionId))
      for (const a of u.abilities) push(a);
    return out;
  });

  const filtered = $derived.by((): AbilityView[] => {
    const q = explorer.abilitySearch.trim().toLowerCase();
    if (!q) return scopeAbilities;
    return scopeAbilities.filter(
      (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
    );
  });

  const groups = $derived(groupAbilities(filtered));
  const total = $derived(filtered.length);

  // Veracity-derived views — only meaningful once a report is loaded.
  const ranked = $derived(rankByVeracity(filtered, scoreFor));
  const shapeAgg = $derived(
    explorer.veracity ? aggregateByShape(filtered, scoreFor) : [],
  );
  const scoredInScope = $derived(
    explorer.veracity ? filtered.filter((a) => scoreFor(a) !== undefined).length : 0,
  );
  let shapePanelOpen = $state(false);

  const scopeLabel = $derived(
    explorer.roundtripAll
      ? "this faction"
      : (explorer.unitId ? units.get(explorer.unitId)?.name : null) ?? "this unit",
  );

  function abilityTypeLabel(a: AbilityView): string {
    const t = (a.raw.ability_type as string | undefined) ?? "unit";
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function describe(a: AbilityView): string {
    try {
      return a.describe();
    } catch (e) {
      return `(describer error: ${e instanceof Error ? e.message : String(e)})`;
    }
  }

  // ── Expand / collapse ─────────────────────────────────────────────────────
  let expanded = $state(new Set<string>());
  let rowEls = $state<Record<string, HTMLDetailsElement>>({});

  function setOpen(id: string, open: boolean): void {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    expanded = next;
  }
  function expandAll(): void {
    expanded = new Set(filtered.map((a) => a.id));
  }
  function collapseAll(): void {
    expanded = new Set();
  }

  // An ability handed in via explorer.inspect() (the datacard QA button) opens
  // its row and scrolls it into view, then clears the target — a one-shot keyed
  // on abilityId, so a later manual collapse of the row isn't undone.
  $effect(() => {
    const id = explorer.abilityId;
    if (!id) return;
    untrack(() => {
      if (!expanded.has(id)) {
        const next = new Set(expanded);
        next.add(id);
        expanded = next;
      }
      rowEls[id]?.scrollIntoView({ block: "nearest" });
    });
    explorer.abilityId = null;
  });

  async function load(force = false): Promise<void> {
    if (!explorer.factionId) {
      index = {};
      count = 0;
      loadedFaction = null;
      return;
    }
    loading = true;
    error = null;
    try {
      const res = await loadFactionIndex(explorer.sourceSpec, explorer.factionId, { force });
      index = res.index;
      sourceLabel = res.label;
      count = res.count;
      loadedFaction = explorer.factionId;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      index = null;
    } finally {
      loading = false;
    }
  }

  function applySource(): void {
    explorer.setSource(specInput.trim());
    void load(true);
  }

  $effect(() => {
    if ((!index && !loading && !error) || loadedFaction !== explorer.factionId) void load();
  });

  function buildRecords(): FlaggedRecord[] {
    const out: FlaggedRecord[] = [];
    for (const id of notes.exportableIds()) {
      const a =
        (explorer.factionId ? abilities.getInFaction(id, explorer.factionId) : undefined) ??
        abilities.getAny(id);
      const n = notes.get(id);
      let desc = "";
      try {
        desc = a ? a.describe() : "";
      } catch {
        desc = "";
      }
      const current_fingerprint = fingerprintText(desc);
      out.push({
        ability_id: id,
        name: a?.name ?? id,
        faction_id: (a?.raw.faction_id as string | null | undefined) ?? null,
        flagged: n.flagged,
        note: n.note,
        source_text: entryToText(index?.[id]),
        dsl: a?.raw ?? null,
        describer: desc,
        reviewed_fingerprint: n.fingerprint,
        current_fingerprint,
        stale: n.fingerprint != null && n.fingerprint !== current_fingerprint,
      });
    }
    return out;
  }

  async function copyJson(): Promise<void> {
    try {
      await navigator.clipboard.writeText(toJson(buildRecords()));
      copyState = "json";
      setTimeout(() => (copyState = "idle"), 1500);
    } catch {
      copyState = "error";
      setTimeout(() => (copyState = "idle"), 1500);
    }
  }

  function downloadMd(): void {
    download("ability-dsl-review.md", toMarkdown(buildRecords()), "text/markdown");
  }

  const exportCount = $derived(notes.exportableIds().length);

  // Stale-flag audit loop: show only entries whose describer changed since review,
  // and a two-step "clear all" so flags don't rot silently across re-authoring.
  let staleOnly = $state(false);
  let confirmClear = $state(false);
  function isRowStale(a: AbilityView): boolean {
    return notes.isStale(a.id, describe(a));
  }
</script>

<div class="toolbar">
  <div class="settings-row" style="flex:1">
    <label for="src">Source</label>
    <input
      id="src"
      class="grow"
      style="flex:1;min-width:200px"
      bind:value={specInput}
      placeholder="owner/repo@ref or a full index.json URL"
      onkeydown={(e) => e.key === "Enter" && applySource()}
    />
    <button onclick={applySource} disabled={loading}>Load</button>
  </div>
  <div>
    <input
      type="file"
      accept=".json,application/json"
      bind:this={reportInput}
      onchange={loadReport}
      hidden
    />
    {#if explorer.veracity}
      <button onclick={clearReport}>Clear veracity</button>
    {:else}
      <button onclick={() => reportInput?.click()}>Load veracity report…</button>
    {/if}
    <button onclick={copyJson} disabled={exportCount === 0}>
      {copyState === "json" ? "Copied ✓" : copyState === "error" ? "Copy failed" : `Copy JSON (${exportCount})`}
    </button>
    <button onclick={downloadMd} disabled={exportCount === 0}>Export .md</button>
  </div>
</div>

<div class="source-status" class:error={!!error}>
  {#if loading}
    Loading source…
  {:else if error}
    Source unavailable — {error}. DSL and describer still work below.
  {:else if index}
    {count} abilities loaded from <code>{sourceLabel}</code>.
  {/if}
</div>

{#if veracityError}
  <div class="source-status error">Veracity report — {veracityError}</div>
{:else if explorer.veracity}
  {@const v = explorer.veracity}
  <div class="source-status veracity-status">
    Veracity: <code>{v.scope}</code> · {v.model} · mean {fmt(v.totals.mean_score)} ·
    min {fmt(v.totals.min_score)} · max {fmt(v.totals.max_score)} ·
    scored {v.totals.scored} · matched {scoredInScope}/{total} in scope
    {#if total > 0 && scoredInScope < total}
      <span class="coverage-warn"
        >({Math.round((scoredInScope / total) * 100)}% coverage — unmatched abilities show no
        score)</span
      >
    {/if}
  </div>
  {#if shapeAgg.length > 0}
    <details class="shape-agg" bind:open={shapePanelOpen}>
      <summary>Veracity by DSL shape (weakest first)</summary>
      <table class="shape-table">
        <thead>
          <tr><th>Shape</th><th>Mean</th><th>Scored</th></tr>
        </thead>
        <tbody>
          {#each shapeAgg as g (g.shape)}
            <tr>
              <td><code>{g.shape}</code></td>
              <td>
                {#if Number.isFinite(g.mean)}
                  <span class="score-badge {badgeClass(g.mean)}">{fmt(g.mean)}</span>
                {:else}
                  <span class="dim">—</span>
                {/if}
              </td>
              <td class="dim">{g.scored}/{g.count}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </details>
  {/if}
{/if}

<div class="collation-bar">
  <span class="collation-count">{total} {total === 1 ? "ability" : "abilities"} · {scopeLabel}</span>
  {#if explorer.veracity}
    <span class="sort-toggle" role="group" aria-label="Collation order">
      <button
        class:active={explorer.roundtripSort === "reading"}
        onclick={() => (explorer.roundtripSort = "reading")}
      >Reading order</button>
      <button
        class:active={explorer.roundtripSort === "veracity"}
        onclick={() => (explorer.roundtripSort = "veracity")}
      >Veracity ↓</button>
    </span>
  {/if}
  <span class="grow"></span>
  <button onclick={expandAll} disabled={total === 0}>Expand all</button>
  <button onclick={collapseAll} disabled={expanded.size === 0}>Collapse all</button>
  <button
    class:active={staleOnly}
    onclick={() => (staleOnly = !staleOnly)}
    title="Show only flags/notes whose describer output changed since you reviewed them"
  >Stale only</button>
  {#if confirmClear}
    <button class="danger" onclick={() => { notes.clearAll(); confirmClear = false; }}>Confirm clear all</button>
    <button onclick={() => (confirmClear = false)}>Cancel</button>
  {:else}
    <button onclick={() => (confirmClear = true)} disabled={exportCount === 0}>Clear all</button>
  {/if}
</div>

{#snippet row(a: AbilityView)}
  {@const entry = index ? index[a.id] : undefined}
  {@const s = scoreFor(a)}
  <details
    class="collation-row"
    bind:this={rowEls[a.id]}
    open={expanded.has(a.id)}
    ontoggle={(e) => setOpen(a.id, (e.currentTarget as HTMLDetailsElement).open)}
  >
    <summary>
      <span class="chevron" aria-hidden="true">▶</span>
      <span class="col-name">{a.name}</span>
      <code class="col-id">{a.id}</code>
      <span class="chip">{abilityTypeLabel(a)}</span>
      {#if s !== undefined}
        <span class="score-badge {badgeClass(s)}" title="Embedding veracity (cosine)">{s.toFixed(2)}</span>
      {/if}
      <span class="col-actions">
        {#if notes.isStale(a.id, describe(a))}
          <span class="stale-badge" title="The describer output changed since you reviewed this — re-verify the note, then re-affirm or clear.">changed</span>
          <button
            class="icon-btn"
            title="Re-affirm: still applies — update the baseline to the current describer"
            onclick={(e) => { e.preventDefault(); notes.reaffirm(a.id, describe(a)); }}
          >↻</button>
        {/if}
        {#if notes.isFlagged(a.id) || notes.get(a.id).note.trim()}
          <button
            class="icon-btn"
            title="Clear this flag/note"
            onclick={(e) => { e.preventDefault(); notes.clear(a.id); }}
          >✕</button>
        {/if}
        <button
          class="icon-btn"
          class:flagged={notes.isFlagged(a.id)}
          title={notes.isFlagged(a.id) ? "Flagged for review" : "Flag for review"}
          onclick={(e) => { e.preventDefault(); notes.toggleFlag(a.id, describe(a)); }}
        >{notes.isFlagged(a.id) ? "⚑" : "⚐"}</button>
      </span>
    </summary>

    {#if expanded.has(a.id)}
      <div class="col-body">
        <textarea
          placeholder="Note for the LLM — what's wrong with the DSL / describer for this ability?"
          value={notes.get(a.id).note}
          oninput={(e) => notes.setNote(a.id, (e.target as HTMLTextAreaElement).value, describe(a))}
        ></textarea>

        <div class="panels">
          <div class="panel">
            <h3>Source text (GW rule)</h3>
            {#if entryKind(entry) === "empty"}
              <p class="muted-note">No source text for <code>{a.id}</code> in this store.</p>
            {:else}
              <div class="prose">{entryToText(entry)}</div>
            {/if}
          </div>
          <div class="panel">
            <h3>Ability DSL</h3>
            <pre>{JSON.stringify(a.raw, null, 2)}</pre>
          </div>
          <div class="panel">
            <h3>Describer output</h3>
            <div class="prose">{describe(a) || "(empty)"}</div>
          </div>
        </div>
      </div>
    {/if}
  </details>
{/snippet}

{#if total === 0}
  <div class="empty-state">
    No abilities in scope. Pick a faction (and optionally a unit) on the left, or
    widen the ability filter.
  </div>
{:else if explorer.veracity && explorer.roundtripSort === "veracity"}
  <div class="collation">
    {#each ranked as a (a.id)}
      {#if !staleOnly || isRowStale(a)}
        {@render row(a)}
      {/if}
    {/each}
  </div>
{:else}
  <div class="collation">
    {#each groups as group (group.label)}
      <div class="collation-group">
        <div class="section-label">{group.label} Abilities</div>
        {#each group.abilities as a (a.id)}
          {#if !staleOnly || isRowStale(a)}
            {@render row(a)}
          {/if}
        {/each}
      </div>
    {/each}
  </div>
{/if}
