<script lang="ts">
import {
	unitRaw,
	unitPoints,
	unitOrdinals,
	eligibleEnhancements,
	withModelCount,
	builderViolations,
	builderUnitToDatacardData,
	canBeWarlord,
	isLeader,
	attachableBodyguards,
	configurationSuggestionsFor,
	type UnitConfigurationSuggestion,
	selectableGrantsFor,
	grantSelectionCount,
	type BuilderState,
	type BuilderUnit,
} from '$lib/data/builder';
import WargearEditor from './WargearEditor.svelte';
import Datacard from '../Datacard.svelte';

interface Props {
	/** The roster-selected unit, or null when nothing is selected. */
	unit: BuilderUnit | null;
	draft: BuilderState;
	onchange: (next: BuilderUnit) => void;
	onconfiguration: (suggestion: UnitConfigurationSuggestion) => void;
	onwarlord: () => void;
}
let { unit, draft, onchange, onconfiguration, onwarlord }: Props = $props();

const armyFaction = $derived(draft.factionId ?? undefined);
const raw = $derived(unit ? unitRaw(unit.datasheetId, unit.factionId, armyFaction) : undefined);
const enhancements = $derived(
	unit ? eligibleEnhancements(draft.detachmentIds, raw, unit.selectedGrants ?? [], armyFaction) : [],
);
const points = $derived(
	unit ? unitPoints(unit, armyFaction, unitOrdinals(draft.units).get(unit.key)) : 0,
);
const modelRange = $derived(raw?.model_count ?? null);
const warlordEligible = $derived(unit ? canBeWarlord(unit, draft.detachmentIds, armyFaction) : false);
const leader = $derived(!!raw && isLeader(raw));
const suggestions = $derived(unit ? configurationSuggestionsFor(draft, unit) : []);
/** Count-limited detachment grants this unit can take (e.g. Houndpack CHARACTER). */
const grants = $derived(
	raw
		? selectableGrantsFor(raw, draft.detachmentIds, armyFaction).map((g) => ({
				...g,
				on: (unit?.selectedGrants ?? []).some((k) => k.toLowerCase() === g.keyword.toLowerCase()),
				picked: grantSelectionCount(draft, g.keyword),
			}))
		: [],
);

function toggleGrant(keyword: string, on: boolean) {
	if (!unit) return;
	const others = (unit.selectedGrants ?? []).filter((k) => k.toLowerCase() !== keyword.toLowerCase());
	onchange({ ...unit, selectedGrants: on ? [...others, keyword] : others });
}
/** Bodyguard rows this leader can attach to, with display names. */
const bodyguards = $derived(
	unit && leader
		? attachableBodyguards(draft, unit).map((b) => ({
				key: b.key,
				name: unitRaw(b.datasheetId, b.factionId, armyFaction)?.name ?? b.datasheetId,
			}))
		: [],
);
const issues = $derived(
	unit
		? builderViolations(draft)
				.filter((v) => v.unitKey === unit.key)
				.map((v) => v.message)
		: [],
);

function setModelCount(n: number) {
	if (!unit) return;
	onchange(withModelCount(unit, n, armyFaction));
}

function setAttachment(key: string) {
	if (!unit) return;
	onchange({ ...unit, attachedToKey: key || undefined });
}
</script>

<div class="flex h-full flex-col">
	{#if !unit}
		<p class="text-text-muted m-auto px-3 text-center text-sm italic">
			Select a unit to edit its models, wargear, and enhancement.
		</p>
	{:else}
		<!-- Header: name + live points. -->
		<div class="mb-2 flex items-baseline gap-2">
			<h3 class="text-text flex-1 text-base font-semibold">{raw?.name ?? unit.datasheetId}</h3>
			<span class="text-text-muted shrink-0 tabular-nums text-sm">{points} pts</span>
		</div>

		<div class="flex flex-col gap-2.5 overflow-y-auto">
			<!-- Model count -->
			<div class="flex items-center gap-2 text-sm">
				<span class="text-text-muted uppercase tracking-wider">Models</span>
				<button
					class="btn btn-icon"
					disabled={unit.modelCount <= (modelRange?.min ?? 1)}
					onclick={() => setModelCount(unit.modelCount - 1)}
					aria-label="fewer models">−</button
				>
				<span class="w-6 text-center tabular-nums">{unit.modelCount}</span>
				<button
					class="btn btn-icon"
					disabled={unit.modelCount >= (modelRange?.max ?? Number.MAX_SAFE_INTEGER)}
					onclick={() => setModelCount(unit.modelCount + 1)}
					aria-label="more models">+</button
				>
				{#if modelRange}<span class="text-text-muted">({modelRange.min}–{modelRange.max})</span>{/if}
			</div>

			{#if issues.length > 0}
				<div class="flex flex-wrap gap-1">
					{#each issues as msg (msg)}
						<span class="rounded bg-amber-900/40 px-1.5 py-0.5 text-xs text-amber-200">{msg}</span>
					{/each}
				</div>
			{/if}

			<!-- Count-limited detachment grants (e.g. select War Dogs as CHARACTER under
			     Houndpack Lance — which is what lets them take Enhancements / be Warlord). -->
			{#each grants as g (g.keyword)}
				<div class="flex items-center gap-2 text-sm">
					<button
						class="btn btn-toggle"
						aria-pressed={g.on}
						disabled={!g.on && g.picked >= g.maxSelected}
						onclick={() => toggleGrant(g.keyword, !g.on)}
					>
						{g.on ? `★ ${g.keyword}` : `Make ${g.keyword}`}
					</button>
					<span class="text-text-muted text-xs">{g.picked}/{g.maxSelected} · {g.detachmentName}</span>
				</div>
			{/each}

			<!-- Warlord — only for units that can actually be Warlord. -->
			{#if warlordEligible}
				<button
					class="btn btn-toggle self-start"
					aria-pressed={unit.isWarlord}
					onclick={onwarlord}
				>
					{unit.isWarlord ? '★ Warlord' : 'Make Warlord'}
				</button>
			{/if}

			{#if suggestions.length > 0}
				<section class="border-panel-border/50 flex flex-col gap-2 border-t pt-2">
					<h4 class="text-text-muted text-xs font-semibold uppercase tracking-wider">Improve this unit</h4>
					{#each suggestions as suggestion (`${suggestion.kind}:${suggestion.providerUnitId}:${suggestion.abilityId}`)}
						<div class="border-panel-border bg-panel/40 flex flex-col gap-2 rounded border p-2">
							<div class="min-w-0">
								<div class="text-text text-sm font-medium">
									{suggestion.providerName} · {suggestion.abilityName}
								</div>
								<p class="text-text-muted mt-0.5 text-xs leading-relaxed">{suggestion.description}</p>
								{#if suggestion.kind === 'aura-position'}
									<p class="text-text-muted mt-1 text-xs">
										Position {suggestion.providerName} within its aura.
									</p>
								{/if}
							</div>
							<div class="self-start">
								{#if suggestion.kind === 'leader-attachment'}
									{#if suggestion.state === 'available'}
										<button
											type="button"
											class="btn btn-toggle"
											onclick={() => onconfiguration(suggestion)}
										>
											{suggestion.attachExistingLeaderKey
												? `Attach ${suggestion.providerName}`
												: `Add ${suggestion.providerName} and attach`}
										</button>
									{:else}
										<span class="text-text-muted text-xs uppercase tracking-wider">Attached</span>
									{/if}
								{:else if suggestion.state === 'add-source'}
									<button
										type="button"
										class="btn btn-toggle"
										onclick={() => onconfiguration(suggestion)}
									>
										Add {suggestion.providerName}
									</button>
								{:else}
									<span class="text-text-muted text-xs uppercase tracking-wider">In roster</span>
								{/if}
							</div>
						</div>
					{/each}
				</section>
			{/if}

			<!-- Leader attachment (11e attaches leaders at list-building time). -->
			{#if leader}
				<label class="text-text-muted flex flex-col gap-1 text-sm uppercase tracking-wider">
					Attached to
					<select
						class="bg-panel border-panel-border text-text rounded border px-2 py-1.5 text-sm normal-case"
						value={unit.attachedToKey ?? ''}
						onchange={(e) => setAttachment((e.target as HTMLSelectElement).value)}
					>
						<option value="">— unattached —</option>
						{#each bodyguards as b (b.key)}
							<option value={b.key}>{b.name}</option>
						{/each}
					</select>
				</label>
			{/if}

			<!-- Enhancement (characters under a detachment only) -->
			{#if enhancements.length > 0}
				<label class="text-text-muted flex flex-col gap-1 text-sm uppercase tracking-wider">
					Enhancement
					<select
						class="bg-panel border-panel-border text-text rounded border px-2 py-1.5 text-sm normal-case"
						value={unit.enhancementId ?? ''}
						onchange={(e) =>
							onchange({ ...unit, enhancementId: (e.target as HTMLSelectElement).value || null })}
					>
						<option value="">— none —</option>
						{#each enhancements as enh (enh.id)}
							<option value={enh.id}>{enh.name} ({enh.cost} pts)</option>
						{/each}
					</select>
				</label>
			{/if}

			<!-- Wargear / loadout -->
			<div class="border-panel-border/50 border-t pt-2">
				<div class="text-text-muted mb-1.5 text-xs font-semibold uppercase tracking-wider">
					Wargear
				</div>
				<WargearEditor {unit} {armyFaction} onchange={(loadout) => onchange({ ...unit, loadout })} />
			</div>

			<!-- Live datacard for the selected unit (reflects the equipped loadout). -->
			<div class="border-panel-border/50 border-t pt-1">
				<Datacard data={builderUnitToDatacardData(unit, armyFaction)} />
			</div>
		</div>
	{/if}
</div>
