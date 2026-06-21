<script lang="ts">
  import { abilities } from "@alpaca-software/40kdc-data";
  import { explorer } from "./store.svelte.js";
  import { notes } from "./notes.svelte.js";
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

  const ability = $derived(
    explorer.abilityId ? abilities.get(explorer.abilityId) : undefined,
  );
  const entry = $derived(
    index && ability ? index[ability.id] : undefined,
  );
  const describer = $derived.by(() => {
    if (!ability) return "";
    try {
      return ability.describe();
    } catch (e) {
      return `(describer error: ${e instanceof Error ? e.message : String(e)})`;
    }
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
  const note = $derived(ability ? notes.get(ability.id).note : "");
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

{#if !ability}
  <div class="empty-state">
    Pick an ability from the list, or hit <b>QA</b> on any ability in the
    datacard view to inspect its source text, DSL, and generated description here.
  </div>
{:else}
  <div class="notes-bar">
    <b style="font-size:var(--text-sm)">{ability.name}</b>
    <code>{ability.id}</code>
    <button
      class:flagged={notes.isFlagged(ability.id)}
      onclick={() => notes.toggleFlag(ability.id)}
    >{notes.isFlagged(ability.id) ? "⚑ Flagged" : "⚐ Flag"}</button>
  </div>

  <textarea
    placeholder="Note for the LLM — what's wrong with the DSL / describer for this ability?"
    value={note}
    oninput={(e) => notes.setNote(ability!.id, (e.target as HTMLTextAreaElement).value)}
    style="width:100%;min-height:60px"
  ></textarea>

  <div class="panels">
    <div class="panel">
      <h3>Source text (GW rule)</h3>
      {#if entryKind(entry) === "empty"}
        <p class="muted-note">No source text for <code>{ability.id}</code> in this store.</p>
      {:else}
        <div class="prose">{entryToText(entry)}</div>
      {/if}
    </div>
    <div class="panel">
      <h3>Ability DSL</h3>
      <pre>{JSON.stringify(ability.raw, null, 2)}</pre>
    </div>
    <div class="panel">
      <h3>Describer output</h3>
      <div class="prose">{describer || "(empty)"}</div>
    </div>
  </div>
{/if}
