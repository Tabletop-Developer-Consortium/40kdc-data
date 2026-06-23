<script lang="ts">
import {
	unitRaw,
	unitPoints,
	unitOrdinals,
	loadoutSummary,
	enhancementName,
	builderViolations,
	attachedLeaders,
	type BuilderState,
	type BuilderUnit,
} from '$lib/data/builder';

interface Props {
	unit: BuilderUnit;
	draft: BuilderState;
	selected: boolean;
	onselect: () => void;
	onclone: () => void;
	onremove: () => void;
}
let { unit, draft, selected, onselect, onclone, onremove }: Props = $props();

const armyFaction = $derived(draft.factionId ?? undefined);
const raw = $derived(unitRaw(unit.datasheetId, unit.factionId, armyFaction));
const points = $derived(unitPoints(unit, armyFaction, unitOrdinals(draft.units).get(unit.key)));
const summary = $derived(loadoutSummary(unit));
/** Selected enhancement's display name, surfaced as a blue chip in the row. */
const enhancement = $derived(unit.enhancementId ? enhancementName(unit.enhancementId) : null);
const hasIssues = $derived(builderViolations(draft).some((v) => v.unitKey === unit.key));
/** Leaders attached to this row (so a bodyguard shows it's being led). */
const leadingCount = $derived(attachedLeaders(draft, unit).length);
</script>

<div
	class="flex items-stretch gap-1.5 rounded border px-2 py-1.5 transition-colors {selected
		? 'border-accent bg-accent/10'
		: 'bg-panel-surface border-panel-border hover:border-panel-border/80'}"
>
	<!-- Main hit area selects the unit and drives the right-hand detail panel. -->
	<button class="flex min-w-0 flex-1 flex-col text-left" onclick={onselect}>
		<div class="flex items-center gap-1.5">
			<span class="text-text truncate text-sm font-medium">{raw?.name ?? unit.datasheetId}</span>
			{#if unit.modelCount > 1}<span class="text-text-muted shrink-0 tabular-nums text-xs"
					>×{unit.modelCount}</span
				>{/if}
			{#if unit.isWarlord}<span class="rounded bg-amber-900/50 px-1 text-xs text-amber-200">WL</span>{/if}
			{#if unit.attachedToKey}<span class="rounded bg-teal-900/50 px-1 text-xs text-teal-200">attached</span>{/if}
			{#if leadingCount > 0}<span class="rounded bg-teal-900/50 px-1 text-xs text-teal-200"
					>leading {leadingCount}</span
				>{/if}
			{#if hasIssues}<span class="shrink-0 text-xs text-amber-400" title="This unit has advisory violations">⚠</span>{/if}
		</div>
		{#if enhancement}
			<span class="truncate text-xs text-blue-300" title={`Enhancement: ${enhancement}`}>{enhancement}</span>
		{/if}
		{#if summary}
			<span class="text-text-muted truncate text-xs italic" title={summary}>{summary}</span>
		{/if}
	</button>

	<div class="flex shrink-0 items-center gap-1.5">
		<span class="text-text-muted tabular-nums text-sm">{points}</span>
		<button class="btn btn-icon" onclick={onclone} title="Duplicate this unit" aria-label="duplicate unit">⧉</button>
		<button class="btn btn-icon btn-danger" onclick={onremove} aria-label="remove unit">×</button>
	</div>
</div>
