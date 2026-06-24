<script lang="ts">
  import type { UnitView, AbilityView } from "@alpaca-software/40kdc-data";
  import { explorer } from "./store.svelte.js";
  import { notes } from "./notes.svelte.js";
  import { groupAbilities } from "./ability-groups.js";

  let { unit }: { unit: UnitView } = $props();

  // ── Stat line ─────────────────────────────────────────────────────────
  const profiles = $derived(unit.raw.profiles);

  // ── Weapons split by type ─────────────────────────────────────────────
  const ranged = $derived(unit.weapons.filter((w) => w.raw.type === "ranged"));
  const melee = $derived(unit.weapons.filter((w) => w.raw.type === "melee"));

  // ── Abilities grouped by type, in datasheet reading order ─────────────
  const groupedAbilities = $derived(groupAbilities(unit.abilities));

  function kwLabel(
    name: string,
    parameters: Record<string, unknown> | undefined,
  ): string {
    const p = parameters ?? {};
    let label = name;
    if (typeof p.target_keyword === "string") {
      const tk = p.target_keyword.replace(/-/g, " ");
      label += name.endsWith("-") ? tk : ` ${tk}`;
    }
    if (p.threshold != null) label += ` ${p.threshold}+`;
    if (p.value != null) label += ` ${p.value}`;
    return label;
  }

  function baseLabel(b: unknown): string | null {
    if (b == null) return null;
    if (typeof b === "string") return b;
    if (typeof b === "number") return `${b}mm`;
    if (typeof b === "object") {
      const o = b as Record<string, unknown>;
      if (typeof o.diameter_mm === "number") return `${o.diameter_mm}mm`;
      if (typeof o.width_mm === "number" && typeof o.length_mm === "number")
        return `${o.width_mm}×${o.length_mm}mm`;
    }
    return null;
  }

  function tierLabel(t: {
    models: number;
    cost: number;
    unit_count_min?: number;
    unit_count_max?: number | null;
  }): string {
    return `${t.models} ${t.models === 1 ? "model" : "models"} · ${t.cost} pts`;
  }

  const base = $derived(baseLabel(unit.raw.base_size_mm));
  const role = $derived(
    unit.raw.role ? unit.raw.role.replace(/-/g, " ") : null,
  );

  function describe(a: AbilityView): string {
    try {
      return a.describe();
    } catch {
      return "";
    }
  }
</script>

<article class="datacard">
  <div class="dc-header">
    <div class="dc-title">
      <h1>{unit.name}</h1>
      <span class="dc-sub">
        {#if role}<span style="text-transform:capitalize">{role}</span>{/if}
        {#if role && unit.faction} · {/if}
        {#if unit.faction}{unit.faction.name}{/if}
        {#if base} · {base} base{/if}
      </span>
    </div>
    {#if unit.raw.points && unit.raw.points.length}
      <div class="dc-points">
        {#each unit.raw.points as t}
          <span class="tier">{tierLabel(t)}</span>
        {/each}
      </div>
    {/if}
  </div>

  {#each profiles as p, i}
    <div class="statline">
      {#if profiles.length > 1}
        <span class="profile-name">{p.name ?? `Profile ${i + 1}`}</span>
      {/if}
      {#each [["M", p.M], ["T", p.T], ["SV", `${p.Sv}+`], ["W", p.W], ["LD", `${p.Ld}+`], ["OC", p.OC]] as [k, v]}
        <span class="stat"><span class="k">{k}</span><span class="v">{v}</span></span>
      {/each}
      {#if p.invuln_sv != null}
        <span class="stat invuln"><span class="k">INV</span><span class="v">{p.invuln_sv}+</span></span>
      {/if}
    </div>
  {/each}

  {#if ranged.length}
    <div class="dc-section">
      <h2>Ranged Weapons</h2>
      <table class="weapons">
        <thead>
          <tr><th class="name">Weapon</th><th>Range</th><th>A</th><th>BS</th><th>S</th><th>AP</th><th>D</th></tr>
        </thead>
        <tbody>
          {#each ranged as w}
            {#each w.raw.profiles as prof, pi}
              <tr>
                <td class="name">
                  {w.raw.profiles.length > 1 ? `${w.name} – ${prof.name}` : w.name}
                  {#if w.keywordsAt(pi).length}
                    <div class="kw-chips">
                      {#each w.keywordsAt(pi) as kw}
                        <span class="chip">{kwLabel(kw.keyword.name, kw.parameters)}</span>
                      {/each}
                    </div>
                  {/if}
                </td>
                <td>{prof.range === "Melee" || prof.range == null ? "—" : `${prof.range}"`}</td>
                <td>{prof.stats.A}</td>
                <td>{prof.stats.BS != null ? `${prof.stats.BS}+` : "—"}</td>
                <td>{prof.stats.S}</td>
                <td>{prof.stats.AP}</td>
                <td>{prof.stats.D}</td>
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if melee.length}
    <div class="dc-section">
      <h2>Melee Weapons</h2>
      <table class="weapons">
        <thead>
          <tr><th class="name">Weapon</th><th>Range</th><th>A</th><th>WS</th><th>S</th><th>AP</th><th>D</th></tr>
        </thead>
        <tbody>
          {#each melee as w}
            {#each w.raw.profiles as prof, pi}
              <tr>
                <td class="name">
                  {w.raw.profiles.length > 1 ? `${w.name} – ${prof.name}` : w.name}
                  {#if w.keywordsAt(pi).length}
                    <div class="kw-chips">
                      {#each w.keywordsAt(pi) as kw}
                        <span class="chip">{kwLabel(kw.keyword.name, kw.parameters)}</span>
                      {/each}
                    </div>
                  {/if}
                </td>
                <td>Melee</td>
                <td>{prof.stats.A}</td>
                <td>{prof.stats.WS != null ? `${prof.stats.WS}+` : "—"}</td>
                <td>{prof.stats.S}</td>
                <td>{prof.stats.AP}</td>
                <td>{prof.stats.D}</td>
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#each groupedAbilities as group}
    <div class="dc-section">
      <h2>{group.label} Abilities</h2>
      <div class="dc-abilities">
        {#each group.abilities as a (a.id)}
          <div class="dc-ability">
            <div class="body">
              <div class="ab-name">{a.name}</div>
              {#if describe(a)}<div class="ab-desc">{describe(a)}</div>{/if}
            </div>
            <div class="ab-actions">
              <button
                class="icon-btn"
                class:flagged={notes.isFlagged(a.id)}
                title={notes.isFlagged(a.id) ? "Flagged for review" : "Flag for review"}
                onclick={() => notes.toggleFlag(a.id, describe(a))}
              >{notes.isFlagged(a.id) ? "⚑" : "⚐"}</button>
              <button class="icon-btn" title="Inspect DSL roundtrip" onclick={() => explorer.inspect(a.id)}>QA</button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/each}

  <div class="dc-keywords">
    {#if unit.raw.keywords && unit.raw.keywords.length}
      <div class="kw-line"><b>Keywords</b>{unit.raw.keywords.join(", ")}</div>
    {/if}
    {#if unit.raw.faction_keywords && unit.raw.faction_keywords.length}
      <div class="kw-line"><b>Faction</b>{unit.raw.faction_keywords.join(", ")}</div>
    {/if}
  </div>
</article>
