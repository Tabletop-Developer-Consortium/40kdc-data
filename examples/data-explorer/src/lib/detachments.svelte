<script lang="ts">
  import { factions } from "@alpaca-software/40kdc-data";
  import type { Enhancement, Stratagem } from "@alpaca-software/40kdc-data";
  import { explorer } from "./store.svelte.js";
  import { notes } from "./notes.svelte.js";
  import { detachmentsForFaction, resolveAbility } from "./detachments.js";

  let { factionId }: { factionId: string } = $props();

  const factionName = $derived(factions.getAny(factionId)?.name ?? factionId);
  const items = $derived(detachmentsForFaction(factionId));

  /** kebab-or-snake token → Title Case for display (type, timing, phases, …). */
  function titleCase(s: string | null | undefined): string {
    if (!s) return "";
    return s
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function stratMeta(s: Stratagem): string {
    return [
      `${s.cp_cost}CP`,
      s.type ? titleCase(s.type) : null,
      s.phases?.length ? s.phases.map(titleCase).join("/") : null,
      titleCase(s.player_turn),
      titleCase(s.timing),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function enhMeta(e: Enhancement): string {
    const parts: string[] = [`${e.cost} pts`];
    if (e.points_provisional) parts.push("provisional");
    if (e.upgrade_tag) parts.push(`upgrade ×${e.max_targets ?? 1}`);
    return parts.join(" · ");
  }

  /** A "label: a, b, c" line, or null when the keyword list is empty. */
  function kwLine(label: string, kws: string[] | null | undefined): string | null {
    return kws && kws.length ? `${label}: ${kws.join(", ")}` : null;
  }
</script>

{#snippet qaButtons(id: string)}
  <div class="ab-actions">
    <button
      class="icon-btn"
      class:flagged={notes.isFlagged(id)}
      title={notes.isFlagged(id) ? "Flagged for review" : "Flag for review"}
      onclick={() => notes.toggleFlag(id)}
    >{notes.isFlagged(id) ? "⚑" : "⚐"}</button>
    <button class="icon-btn" title="Inspect DSL roundtrip" onclick={() => explorer.inspect(id)}>QA</button>
  </div>
{/snippet}

<section class="detach-block">
  <div class="detach-head">
    <h2>{factionName} Detachments</h2>
    <span class="detach-count">{items.length}</span>
  </div>

  {#if items.length === 0}
    <p class="dim" style="font-size:var(--text-xs)">No detachments for this faction.</p>
  {/if}

  {#each items as d (d.raw.faction_id + "::" + d.raw.id)}
    <details class="detach-card">
      <summary>
        <span class="detach-name">{d.raw.name}</span>
        <span class="detach-summary-meta">
          {#if d.raw.detachment_points != null}<span class="detach-pts">{d.raw.detachment_points} DP</span>{/if}
          {#each d.dispositions as fd (fd.id)}<span class="chip accent">{fd.name}</span>{/each}
          {#each d.raw.tags ?? [] as t}<span class="chip">{titleCase(t)}</span>{/each}
          <span class="detach-counts">{d.enhancements.length}E · {d.stratagems.length}S</span>
        </span>
      </summary>

      <div class="detach-body">
        <!-- Detachment rule(s) -->
        {#if d.rules.length}
          <div class="dc-section">
            <h2>Detachment Rule{d.rules.length > 1 ? "s" : ""}</h2>
            <div class="dc-abilities">
              {#each d.rules as r (r.id)}
                <div class="dc-ability">
                  <div class="body">
                    <div class="ab-name">{r.name}</div>
                    {#if r.description}<div class="ab-desc">{r.description}</div>{/if}
                  </div>
                  {@render qaButtons(r.id)}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Force dispositions -->
        {#if d.dispositions.length}
          <div class="dc-section">
            <h2>Force Disposition{d.dispositions.length > 1 ? "s" : ""}</h2>
            <div class="disp-list">
              {#each d.dispositions as fd (fd.id)}
                <div class="disp">
                  <span class="chip accent">{fd.name}</span>
                  {#if fd.text}<span class="disp-text">{fd.text}</span>{/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Enhancements -->
        {#if d.enhancements.length}
          <div class="dc-section">
            <h2>Enhancements</h2>
            <div class="dc-abilities">
              {#each d.enhancements as e (e.id)}
                {@const ability = resolveAbility(e.ability_id)}
                <div class="dc-ability">
                  <div class="body">
                    <div class="ab-name">{e.name} <span class="meta-inline">{enhMeta(e)}</span></div>
                    {#if kwLine("Requires", e.keyword_restrictions)}<div class="ab-restrict">{kwLine("Requires", e.keyword_restrictions)}</div>{/if}
                    {#if kwLine("Excludes", e.exclusion_keywords)}<div class="ab-restrict">{kwLine("Excludes", e.exclusion_keywords)}</div>{/if}
                    {#if ability?.description}<div class="ab-desc">{ability.description}</div>{/if}
                  </div>
                  {#if ability}{@render qaButtons(ability.id)}{/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Stratagems -->
        {#if d.stratagems.length}
          <div class="dc-section">
            <h2>Stratagems</h2>
            <div class="dc-abilities">
              {#each d.stratagems as s (s.id)}
                {@const ability = resolveAbility(s.ability_id)}
                {@const tr = s.target_restrictions}
                <div class="dc-ability">
                  <div class="body">
                    <div class="ab-name strat-name">{s.name}</div>
                    <div class="meta-inline">{stratMeta(s)}</div>
                    {#if tr}
                      {#if kwLine("Targets", tr.required_keywords)}<div class="ab-restrict">{kwLine("Targets", tr.required_keywords)}</div>{/if}
                      {#if kwLine("Targets any", tr.required_keywords_any)}<div class="ab-restrict">{kwLine("Targets any", tr.required_keywords_any)}</div>{/if}
                      {#if kwLine("Excludes", tr.excluded_keywords)}<div class="ab-restrict">{kwLine("Excludes", tr.excluded_keywords)}</div>{/if}
                    {/if}
                    {#if ability?.description}<div class="ab-desc">{ability.description}</div>{/if}
                  </div>
                  {#if ability}{@render qaButtons(ability.id)}{/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Construction constraints -->
        {#if (d.raw.restrictions && (d.raw.restrictions.required_keywords?.length || d.raw.restrictions.excluded_keywords?.length || d.raw.restrictions.notes)) || d.raw.granted_keywords?.length || d.raw.unit_minimums?.length}
          <div class="dc-keywords">
            {#if kwLine("Army requires", d.raw.restrictions?.required_keywords)}<div class="kw-line">{kwLine("Army requires", d.raw.restrictions?.required_keywords)}</div>{/if}
            {#if kwLine("Army excludes", d.raw.restrictions?.excluded_keywords)}<div class="kw-line">{kwLine("Army excludes", d.raw.restrictions?.excluded_keywords)}</div>{/if}
            {#if d.raw.restrictions?.notes}<div class="kw-line">{d.raw.restrictions.notes}</div>{/if}
            {#each d.raw.granted_keywords ?? [] as g}
              <div class="kw-line">Grants <b style="margin:0">{g.keyword}</b> to {g.to_keywords.join(", ")}{g.max_selected != null ? ` (up to ${g.max_selected})` : ""}</div>
            {/each}
            {#each d.raw.unit_minimums ?? [] as m}
              <div class="kw-line">Requires {m.min}+ {m.keyword} units</div>
            {/each}
          </div>
        {/if}
      </div>
    </details>
  {/each}
</section>
