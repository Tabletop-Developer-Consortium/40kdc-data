<script lang="ts">
  import { worklistFor, type EditLayout, type WorklistRow } from "./model.js";
  import { TERRAIN_SETS, type TerrainSetDef } from "./sets.js";

  /**
   * The re-authoring checklist: what areas the layout is *expected* to contain,
   * and how many are placed.
   *
   * The inventory comes from the committed layout for the same matchup+variant,
   * whose child/feature layer is exact — but whose board-level placement is not,
   * which is why the layouts are being re-authored. So this panel shows the
   * inventory and the feature seats and **nothing positional**: no coordinates
   * and deliberately no rotations, since essentially every committed layout has
   * at least one footprint rotated wrong and surfacing those would launder a
   * known-bad number into the new pass.
   *
   * Advisory only — it writes nothing. "Stamp" just calls the same palette action.
   */
  interface Props {
    layout: EditLayout;
    onstampset: (s: TerrainSetDef) => void;
  }
  let { layout, onstampset }: Props = $props();

  const work = $derived(worklistFor(layout, TERRAIN_SETS));
  const setById = new Map(TERRAIN_SETS.map((s) => [s.id, s]));
  const done = (r: WorklistRow): boolean => r.placed >= r.expected;
</script>

{#if work.sourceId}
  <details class="worklist">
    <summary>
      <span class="title">Worklist</span>
      <span class="count" class:complete={work.placed >= work.expected}>
        {work.placed}/{work.expected} areas
      </span>
    </summary>

    <p class="src">inventory from <code>{work.sourceId}</code></p>

    <ul>
      {#each work.rows as row (row.key)}
        <li class:done={done(row)}>
          <span class="tick" aria-hidden="true">{done(row) ? "✓" : "○"}</span>
          <span class="body">
            <span class="area">
              {row.areaName}
              {#if row.expected > 1}<span class="mult">×{row.expected}</span>{/if}
              <span class="tally">{row.placed}/{row.expected}</span>
            </span>
            {#if row.seats.length > 0}
              <span class="seats">
                {#each row.seats as s (s.template)}
                  <span class="seat">{s.name}{#if s.count > 1}<span class="mult">×{s.count}</span>{/if}</span>
                {/each}
              </span>
            {:else}
              <span class="seats empty">bare area</span>
            {/if}
          </span>
          {#if row.setId}
            <button
              class="stamp"
              title="Stamp the {setById.get(row.setId)?.name} set"
              onclick={() => {
                const s = setById.get(row.setId!);
                if (s) onstampset(s);
              }}>stamp</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .worklist {
    border-bottom: 1px solid var(--border, #2a2f3a);
    padding: 0.5rem 0.6rem 0.6rem;
    font-size: 0.78rem;
  }
  summary {
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-weight: 600;
  }
  .title {
    flex: 1;
  }
  .count {
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
    font-weight: 500;
  }
  .count.complete {
    color: var(--ok, #4ade80);
    opacity: 1;
  }
  .src {
    margin: 0.4rem 0 0.5rem;
    opacity: 0.6;
    font-size: 0.72rem;
  }
  .src code {
    font-size: 0.72rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
  }
  li.done {
    opacity: 0.5;
  }
  .tick {
    width: 0.9em;
    flex: none;
    opacity: 0.8;
  }
  li.done .tick {
    color: var(--ok, #4ade80);
    opacity: 1;
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .area {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
  }
  .tally {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    opacity: 0.6;
    font-size: 0.72rem;
  }
  .mult {
    opacity: 0.65;
    font-size: 0.72rem;
  }
  .seats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.4rem;
    opacity: 0.7;
    font-size: 0.72rem;
  }
  .seats.empty {
    font-style: italic;
    opacity: 0.5;
  }
  .stamp {
    flex: none;
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    cursor: pointer;
  }
</style>
