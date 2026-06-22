<script lang="ts">
  import { untrack } from "svelte";
  import { abilities, units } from "@alpaca-software/40kdc-data";
  import type { AbilityView } from "@alpaca-software/40kdc-data";
  import { explorer } from "./store.svelte.js";
  import { notes } from "./notes.svelte.js";
  import { groupAbilities } from "./ability-groups.js";
  import {
    loadIndex,
    entryKind,
    entryToText,
    type StoreIndex,
  } from "./source-store.js";
  import { toJson, toMarkdown, download, type FlaggedRecord } from "./export.js";

  let index = $state<StoreIndex | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let sourceLabel = $state("");
  let count = $state(0);
  let specInput = $state(explorer.sourceSpec);
  let copyState = $state<"idle" | "json" | "error">("idle");

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
    loading = true;
    error = null;
    try {
      const res = await loadIndex(explorer.sourceSpec, { force });
      index = res.index;
      sourceLabel = res.label;
      count = res.count;
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
    // Lazy first load when the view is opened.
    if (index === null && !loading && !error) void load();
  });

  function buildRecords(): FlaggedRecord[] {
    const out: FlaggedRecord[] = [];
    for (const id of notes.exportableIds()) {
      const a = abilities.get(id);
      const n = notes.get(id);
      let desc = "";
      try {
        desc = a ? a.describe() : "";
      } catch {
        desc = "";
      }
      out.push({
        ability_id: id,
        name: a?.name ?? id,
        faction_id: (a?.raw.faction_id as string | null | undefined) ?? null,
        flagged: n.flagged,
        note: n.note,
        source_text: entryToText(index?.[id]),
        dsl: a?.raw ?? null,
        describer: desc,
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

<div class="collation-bar">
  <span class="collation-count">{total} {total === 1 ? "ability" : "abilities"} · {scopeLabel}</span>
  <span class="grow"></span>
  <button onclick={expandAll} disabled={total === 0}>Expand all</button>
  <button onclick={collapseAll} disabled={expanded.size === 0}>Collapse all</button>
</div>

{#if total === 0}
  <div class="empty-state">
    No abilities in scope. Pick a faction (and optionally a unit) on the left, or
    widen the ability filter.
  </div>
{:else}
  <div class="collation">
    {#each groups as group (group.label)}
      <div class="collation-group">
        <div class="section-label">{group.label} Abilities</div>
        {#each group.abilities as a (a.id)}
          {@const entry = index ? index[a.id] : undefined}
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
              <span class="col-actions">
                <button
                  class="icon-btn"
                  class:flagged={notes.isFlagged(a.id)}
                  title={notes.isFlagged(a.id) ? "Flagged for review" : "Flag for review"}
                  onclick={(e) => { e.preventDefault(); notes.toggleFlag(a.id); }}
                >{notes.isFlagged(a.id) ? "⚑" : "⚐"}</button>
              </span>
            </summary>

            {#if expanded.has(a.id)}
              <div class="col-body">
                <textarea
                  placeholder="Note for the LLM — what's wrong with the DSL / describer for this ability?"
                  value={notes.get(a.id).note}
                  oninput={(e) => notes.setNote(a.id, (e.target as HTMLTextAreaElement).value)}
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
        {/each}
      </div>
    {/each}
  </div>
{/if}
