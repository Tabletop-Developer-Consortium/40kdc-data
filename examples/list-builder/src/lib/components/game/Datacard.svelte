<script lang="ts">
import type { DatacardData } from '$lib/types/DatacardData';
import { ds } from '$lib/data/dataset';

interface Props {
	data: DatacardData;
}
let { data }: Props = $props();

const playerColor = $derived(data.player === 'Attacker' ? 'text-red-400' : 'text-blue-400');

// Resolve everything static from the embedded 40kdc dataset by id. A null
// datasheet_id means the import never resolved this unit — render the
// degraded card (raw name + loadout text) instead of going blank.
// Scope to faction_id when known so a shared chassis (e.g. the Chaos cult
// legions) resolves the right copy; fall back to a faction-less lookup
// (getAny) only when faction is genuinely unknown.
const unit = $derived(
	!data.datasheet_id
		? undefined
		: data.faction_id
			? (ds.units.getInFaction(data.datasheet_id, data.faction_id) ??
				ds.units.getAny(data.datasheet_id))
			: ds.units.getAny(data.datasheet_id),
);

function stat(v: unknown): string {
	return v == null ? '-' : String(v);
}

type WeaponRow = {
	name: string;
	range: string | null;
	attacks: string;
	skill: string;
	strength: string;
	ap: string;
	damage: string;
};

function weaponRows(ids: string[]): WeaponRow[] {
	return ids.flatMap((id) => {
		const view =
			(data.faction_id ? ds.weapons.getInFaction(id, data.faction_id) : undefined) ??
			ds.weapons.getAny(id);
		if (!view) return [];
		const multi = view.raw.profiles.length > 1;
		return view.raw.profiles.map((p) => ({
			name: multi ? `${view.name} — ${p.name}` : view.name,
			range: typeof p.range === 'number' ? `${p.range}"` : null,
			attacks: stat(p.stats.A),
			skill: p.stats.BS != null ? `${p.stats.BS}+` : p.stats.WS != null ? `${p.stats.WS}+` : '-',
			strength: stat(p.stats.S),
			ap: stat(p.stats.AP),
			damage: stat(p.stats.D)
		}));
	});
}

const rangedRows = $derived(weaponRows(data.ranged_weapon_ids));
const meleeRows = $derived(weaponRows(data.melee_weapon_ids));

// Abilities: names from the datasheet's ability refs; tooltip text is the
// conformance-pinned generated approximation (the dataset has no rules prose).
const abilities = $derived(
	(unit?.abilities ?? []).map((a) => ({ name: a.name, description: a.describe() }))
);

const keywords = $derived([
	...(unit?.raw.keywords ?? []),
	...(unit?.raw.faction_keywords ?? [])
]);
</script>

<div class="px-2 py-2 text-xs">
	<!-- Header -->
	<div class="flex items-baseline justify-between gap-1">
		<span class="text-text font-heading text-xs font-bold uppercase tracking-wider">{data.unit_name}</span>
		<span class="{playerColor} text-xs">{data.player}</span>
	</div>

	{#if unit}
		<!-- Stat lines (one per datasheet profile) -->
		{#if unit.raw.profiles.length > 0}
			<div class="border-panel-border mt-1 border-t pt-1">
				<div class="text-text-muted flex gap-2 text-xs">
					<span class="w-6 text-center">M</span>
					<span class="w-4 text-center">T</span>
					<span class="w-5 text-center">Sv</span>
					<span class="w-5 text-center">Inv</span>
					<span class="w-4 text-center">W</span>
					<span class="w-5 text-center">Ld</span>
					<span class="w-5 text-center">OC</span>
				</div>
				{#each unit.raw.profiles as p, i (i)}
					<div class="text-text font-mono flex gap-2 text-xs">
						<span class="w-6 text-center">{stat(p.M)}"</span>
						<span class="w-4 text-center">{stat(p.T)}</span>
						<span class="w-5 text-center">{stat(p.Sv)}+</span>
						<span class="text-text-muted w-5 text-center"
							>{p.invuln_sv != null ? `${p.invuln_sv}+` : '—'}</span
						>
						<span class="w-4 text-center">{stat(p.W)}</span>
						<span class="w-5 text-center">{stat(p.Ld)}+</span>
						<span class="w-5 text-center">{stat(p.OC)}</span>
					</div>
					{#if unit.raw.profiles.length > 1 && p.name}
						<div class="text-text-muted pl-1 text-xs">{p.name}</div>
					{/if}
				{/each}
			</div>
		{/if}

		<!-- Ranged weapons (stacked layout) -->
		{#if rangedRows.length > 0}
			<details class="border-panel-border mt-1 border-t pt-1" open>
				<summary class="text-text-muted cursor-pointer text-xs font-bold uppercase tracking-wider">
					<span class="expand-indicator text-xs">▸</span> Ranged
				</summary>
				{#each rangedRows as w (w.name)}
					<div class="mt-0.5">
						<div class="text-text text-xs font-medium">{w.name}</div>
						<div class="text-text-muted font-mono flex flex-wrap gap-x-2 text-xs">
							{#if w.range != null}<span>{w.range}</span>{/if}
							<span>A:{w.attacks}</span>
							<span>BS:{w.skill}</span>
							<span>S:{w.strength}</span>
							<span>AP:{w.ap}</span>
							<span>D:{w.damage}</span>
						</div>
					</div>
				{/each}
			</details>
		{/if}

		<!-- Melee weapons (stacked layout) -->
		{#if meleeRows.length > 0}
			<details class="border-panel-border mt-1 border-t pt-1" open>
				<summary class="text-text-muted cursor-pointer text-xs font-bold uppercase tracking-wider">
					<span class="expand-indicator text-xs">▸</span> Melee
				</summary>
				{#each meleeRows as w (w.name)}
					<div class="mt-0.5">
						<div class="text-text text-xs font-medium">{w.name}</div>
						<div class="text-text-muted font-mono flex flex-wrap gap-x-2 text-xs">
							<span>A:{w.attacks}</span>
							<span>WS:{w.skill}</span>
							<span>S:{w.strength}</span>
							<span>AP:{w.ap}</span>
							<span>D:{w.damage}</span>
						</div>
					</div>
				{/each}
			</details>
		{/if}

		<!-- Abilities — name header + generated describer text, always visible (no hover). -->
		{#if abilities.length > 0}
			<div class="border-panel-border mt-1 border-t pt-1">
				<div class="text-text-muted text-xs font-bold uppercase tracking-wider">Abilities</div>
				<div class="mt-0.5 flex flex-col gap-1">
					{#each abilities as ability (ability.name)}
						<div>
							<div class="text-text text-sm font-semibold">{ability.name}</div>
							{#if ability.description}
								<div class="text-text-muted text-xs leading-snug">{ability.description}</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Keywords -->
		{#if keywords.length > 0}
			<div class="border-panel-border mt-1 border-t pt-1">
				<div class="text-text-muted text-xs font-bold uppercase tracking-wider">Keywords</div>
				<div class="text-text-muted text-xs italic">{keywords.join(', ')}</div>
			</div>
		{/if}
	{:else}
		<!-- Unresolved import: degrade to raw list data, never a blank card -->
		<div class="border-panel-border mt-1 border-t pt-1">
			<p class="text-text-muted text-xs italic">Unit not found in the 40kdc dataset.</p>
			{#if data.loadout_raw_names.length > 0}
				<div class="text-text-muted mt-1 text-xs font-bold uppercase tracking-wider">Loadout</div>
				<div class="text-text-muted text-xs">{data.loadout_raw_names.join(', ')}</div>
			{/if}
		</div>
	{/if}
</div>
