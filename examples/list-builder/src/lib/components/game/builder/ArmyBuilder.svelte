<script lang="ts">
import { untrack } from 'svelte';
import { ds } from '$lib/data/dataset';
import {
	emptyBuilderState,
	detachmentsForFaction,
	detachmentRaw,
	detachmentPointCost,
	totalDetachmentPoints,
	detachmentPointCap,
	createBuilderUnit,
	applyConfigurationSuggestion,
	totalPoints,
	pointsLimit,
	builderViolations,
	builderToRoster,
	builderToRosterJson,
	groupDraftByRole,
	cloneBuilderUnit,
	unitRaw,
	type BuilderState,
	type BuilderUnit,
	type UnitConfigurationSuggestion,
	type BattleSize,
} from '$lib/data/builder';
import UnitPicker from './UnitPicker.svelte';
import BuilderUnitRow from './BuilderUnitRow.svelte';
import UnitDetailPanel from './UnitDetailPanel.svelte';
import ShareModal from '../../ShareModal.svelte';
import BottomSheet from '../../../../../../_shared/BottomSheet.svelte';
import { viewport } from '$lib/media.svelte';

interface Props {
	/** Seed for "Edit in Builder"; omitted for a from-scratch build. */
	initial?: BuilderState;
	/** Persist: roster-json text + display name + disposition id. */
	onsave: (text: string, name: string, disposition: string | null) => void;
	oncancel: () => void;
	/**
	 * Live-session tap: fires after every draft mutation with the current
	 * state. The host diffs against its last-known session doc, so the
	 * callback being called for remote-originated changes is harmless (the
	 * diff is empty).
	 */
	ondraftchange?: (draft: BuilderState) => void;
	/**
	 * Embedded as one army of a Doubles team: the team owner renders the
	 * battle-size/points level, the (team) disposition, the toggle, and the
	 * footer — so those controls hide here and the points ceiling comes from
	 * the draft's `pointsLimitOverride`.
	 */
	doubles?: boolean;
	/** Solo header's "Doubles" toggle — hands the current draft to the host. */
	ondoubles?: (draft: BuilderState) => void;
}
let { initial, onsave, oncancel, ondraftchange, doubles = false, ondoubles }: Props = $props();

// Deep-copy the seed without structuredClone — `initial` is a Svelte $state
// proxy (uncloneable by structuredClone), and the per-unit loadout is a Map
// that a shallow spread would alias.
function cloneSeed(s: BuilderState): BuilderState {
	return {
		...s,
		units: s.units.map((u) => ({ ...u, loadout: new Map(u.loadout) })),
	};
}
let draft = $state<BuilderState>(initial ? cloneSeed(initial) : emptyBuilderState());
/** Roster row driving the right-hand detail panel; seeds to the first unit. */
let selectedKey = $state<string | null>(initial?.units[0]?.key ?? null);

// Key space is suffixed with a per-instance nonce so two builders editing
// the SAME list in a live session can never mint colliding row keys (both
// would otherwise start at "u0"). Solo behavior is unchanged — keys are
// opaque strings that only need uniqueness within a draft.
const instanceNonce = Math.random().toString(36).slice(2, 6);
let keyCounter = 0;
function nextKey(): string {
	return `u${keyCounter++}-${instanceNonce}`;
}

// Draft tap (no-op without the prop; reads draft deeply so any mutation —
// scalar, unit row, loadout Map replacement — schedules it). The callback
// itself runs untracked: a host that reads *and writes* its own state in the
// handler (the doubles workspace mirroring armies) must not become a
// dependency of this effect, or the write re-triggers it in a loop.
$effect(() => {
	if (!ondraftchange) return;
	const snapshot = cloneSeed(draft);
	untrack(() => ondraftchange(snapshot));
});

/**
 * Replace the whole draft from a live session (welcome or remote ops).
 * Exported for the host via `bind:this`. Keeps the detail-panel selection
 * when the selected row still exists.
 */
export function replaceDraft(next: BuilderState): void {
	draft = cloneSeed(next);
	if (selectedKey && !next.units.some((u) => u.key === selectedKey)) {
		selectedKey = next.units[0]?.key ?? null;
	}
}

const factions = $derived(ds.factions.all.slice().sort((a, b) => a.name.localeCompare(b.name)));
const detachments = $derived(detachmentsForFaction(draft.factionId));
const dispositions = $derived(ds.forceDispositions.all);

// Disposition as the locked spine: a detachment that grants dispositions
// constrains the choice to that set (empty upstream today → manual fallback).
// With several detachments the constraint is the union of what they grant.
const forcedDispositions = $derived(
	[...new Set(draft.detachmentIds.flatMap((id) => detachmentRaw(id, draft.factionId ?? undefined)?.force_dispositions ?? []))],
);
$effect(() => {
	if (
		forcedDispositions.length > 0 &&
		(!draft.disposition || !forcedDispositions.includes(draft.disposition))
	) {
		draft.disposition = forcedDispositions[0];
	}
});
function dispositionName(id: string | null): string {
	return id ? (ds.forceDispositions.get(id)?.name ?? id) : '—';
}

const total = $derived(totalPoints(draft));
const limit = $derived(pointsLimit(draft));
const overLimit = $derived(total > limit);
const dpSpent = $derived(totalDetachmentPoints(draft));
const dpCap = $derived(detachmentPointCap(draft));
const overDp = $derived(dpSpent > dpCap);
const armyIssues = $derived(builderViolations(draft).filter((v) => v.unitKey === null));
const draftGroups = $derived(groupDraftByRole(draft));
const selected = $derived(draft.units.find((u) => u.key === selectedKey) ?? null);
/** Display name for the mobile detail sheet's title. */
const selectedName = $derived(
	selected
		? (unitRaw(selected.datasheetId, selected.factionId, draft.factionId ?? undefined)?.name ??
				selected.datasheetId)
		: '',
);

// Mobile bottom sheets (only mounted below the desktop breakpoint): the unit
// picker and the selected-unit detail panel, which on desktop are the left and
// right grid columns. `selectUnit` opens the detail sheet on mobile.
let pickerOpen = $state(false);
let detailOpen = $state(false);
function selectUnit(key: string) {
	selectedKey = key;
	if (viewport.isMobile) detailOpen = true;
}

// Share modal: lower the draft to a canonical Roster only while the modal is open.
let shareOpen = $state(false);
const shareRoster = $derived(shareOpen ? builderToRoster(draft) : null);

function setFaction(id: string) {
	// Keep the units — many armies field allied / agent units from other
	// factions. The detachment is faction-scoped, so it (and any
	// detachment-scoped enhancements) reset; selections otherwise stay.
	draft.factionId = id || null;
	draft.detachmentIds = [];
	draft.units = draft.units.map((u) => ({ ...u, enhancementId: null }));
}

/** Toggle a detachment in/out of the selection, preserving pick order. */
function toggleDetachment(id: string, on: boolean) {
	if (on) {
		if (!draft.detachmentIds.includes(id)) draft.detachmentIds = [...draft.detachmentIds, id];
	} else {
		draft.detachmentIds = draft.detachmentIds.filter((d) => d !== id);
		// Dropping a detachment can orphan its enhancements — clear any that no
		// longer belong to a selected detachment.
		const allowed = new Set(
			draft.detachmentIds.flatMap((d) => detachmentRaw(d, draft.factionId ?? undefined)?.enhancement_ids ?? []),
		);
		draft.units = draft.units.map((u) =>
			u.enhancementId && !allowed.has(u.enhancementId) ? { ...u, enhancementId: null } : u,
		);
	}
}

function addUnit(datasheetId: string, factionId?: string, allyRuleId?: string) {
	const bu = createBuilderUnit(
		datasheetId,
		nextKey(),
		draft.factionId ?? undefined,
		factionId,
		allyRuleId,
	);
	if (!bu) return;
	draft.units = [...draft.units, bu];
	selectedKey = bu.key;
	// On mobile, close the picker sheet so the new unit shows in the roster
	// underneath (no-op on desktop, where the picker is a column).
	pickerOpen = false;
}

function cloneUnit(key: string) {
	const idx = draft.units.findIndex((u) => u.key === key);
	if (idx < 0) return;
	const copy = cloneBuilderUnit(draft.units[idx], nextKey());
	// Insert right after the source so it lands in the same role section.
	draft.units = [...draft.units.slice(0, idx + 1), copy, ...draft.units.slice(idx + 1)];
	selectedKey = copy.key;
}

function updateUnit(next: BuilderUnit) {
	draft.units = draft.units.map((u) => (u.key === next.key ? next : u));
}

function applyConfiguration(suggestion: UnitConfigurationSuggestion) {
	draft = applyConfigurationSuggestion(draft, suggestion, nextKey);
}

function removeUnit(key: string) {
	// Drop the row and clear any leader still attached to it.
	draft.units = draft.units
		.filter((u) => u.key !== key)
		.map((u) => (u.attachedToKey === key ? { ...u, attachedToKey: undefined } : u));
	if (selectedKey === key) selectedKey = null;
}

function setWarlord(key: string) {
	// Toggle: clicking the current warlord clears it (zero warlords is allowed);
	// otherwise this unit becomes the sole warlord.
	const turnOff = draft.units.find((u) => u.key === key)?.isWarlord ?? false;
	draft.units = draft.units.map((u) => ({ ...u, isWarlord: turnOff ? false : u.key === key }));
}

function save() {
	onsave(builderToRosterJson(draft), draft.name || 'Untitled', draft.disposition);
}
</script>

<div class="flex h-full flex-col gap-2">
	<!-- Header: name, faction, detachment, battle size, disposition, points. -->
	<div class="flex shrink-0 flex-wrap items-end gap-2">
		<label class="flex flex-col text-xs uppercase tracking-wider text-text-muted max-lg:flex-1 max-lg:basis-[46%]">
			Name
			<input
				type="text"
				class="bg-panel border-panel-border text-text mt-0.5 w-44 rounded border px-2 py-1 text-sm normal-case max-lg:w-full"
				placeholder="My list"
				bind:value={draft.name}
			/>
		</label>
		<label class="flex flex-col text-xs uppercase tracking-wider text-text-muted max-lg:flex-1 max-lg:basis-[46%]">
			Faction
			<select
				class="bg-panel border-panel-border text-text mt-0.5 rounded border px-1.5 py-1 text-sm"
				value={draft.factionId ?? ''}
				onchange={(e) => setFaction((e.target as HTMLSelectElement).value)}
			>
				<option value="">— select —</option>
				{#each factions as f (f.id)}
					<option value={f.id}>{f.name}</option>
				{/each}
			</select>
		</label>
		<label class="flex flex-col text-xs uppercase tracking-wider text-text-muted max-lg:flex-1 max-lg:basis-[46%]">
			Detachments <span class="normal-case {overDp ? 'text-amber-400' : 'text-text-muted'}">({dpSpent}/{dpCap} DP)</span>
			<select
				class="bg-panel border-panel-border text-text mt-0.5 rounded border px-1.5 py-1 text-sm disabled:opacity-40"
				value=""
				disabled={!draft.factionId}
				onchange={(e) => {
					const v = (e.target as HTMLSelectElement).value;
					if (v) toggleDetachment(v, true);
					(e.target as HTMLSelectElement).value = '';
				}}
			>
				<option value="">+ add detachment</option>
				{#each detachments.filter((d) => !draft.detachmentIds.includes(d.id)) as d (d.id)}
					<option value={d.id}>{d.name} ({detachmentPointCost(d.id, draft.factionId ?? undefined)} DP)</option>
				{/each}
			</select>
			{#if draft.detachmentIds.length > 0}
				<div class="mt-1 flex flex-wrap gap-1">
					{#each draft.detachmentIds as id (id)}
						<span class="bg-panel border-panel-border text-text flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs normal-case">
							{detachmentRaw(id, draft.factionId ?? undefined)?.name ?? id} ({detachmentPointCost(id, draft.factionId ?? undefined)} DP)
							<button
								type="button"
								class="text-text-dim hover:text-amber-400"
								title="Remove detachment"
								aria-label="Remove detachment"
								onclick={() => toggleDetachment(id, false)}>×</button
							>
						</span>
					{/each}
				</div>
			{/if}
		</label>
		{#if !doubles}
		<label class="flex flex-col text-xs uppercase tracking-wider text-text-muted max-lg:flex-1 max-lg:basis-[46%]">
			Battle size
			<select
				class="bg-panel border-panel-border text-text mt-0.5 rounded border px-1.5 py-1 text-sm"
				value={draft.battleSize}
				onchange={(e) => (draft.battleSize = (e.target as HTMLSelectElement).value as BattleSize)}
			>
				<option value="incursion">Incursion</option>
				<option value="strike-force">Strike Force</option>
			</select>
		</label>
		{#if ondoubles}
			<label
				class="border-panel-border bg-panel flex items-center gap-1.5 self-end rounded border px-2 py-1.5 text-xs uppercase tracking-wider text-text-muted"
				title="Build a Doubles team — two armies fighting as one force"
			>
				<input type="checkbox" checked={false} onchange={() => ondoubles?.(draft)} />
				Doubles
			</label>
		{/if}
		<label class="flex flex-col text-xs uppercase tracking-wider text-text-muted max-lg:flex-1 max-lg:basis-[46%]">
			Disposition
			{#if forcedDispositions.length > 1}
				<!-- Detachment grants several — choose within the granted set. Lock stays
				     inline so the field height matches the unlocked state (no redraw). -->
				<div class="mt-0.5 flex items-center gap-1">
					<select
						class="bg-panel border-panel-border text-text min-w-0 flex-1 rounded border px-1.5 py-1 text-sm"
						value={draft.disposition ?? ''}
						onchange={(e) => (draft.disposition = (e.target as HTMLSelectElement).value || null)}
					>
						{#each forcedDispositions as id (id)}
							<option value={id}>{dispositionName(id)}</option>
						{/each}
					</select>
					<span class="shrink-0 text-text-muted" title="Set by your detachment" aria-label="Set by your detachment">🔒</span>
				</div>
			{:else if forcedDispositions.length === 1}
				<!-- Single granted disposition — locked, lock inline on the same line. -->
				<div
					class="bg-panel/60 border-panel-border text-text mt-0.5 flex items-center justify-between gap-1 rounded border px-1.5 py-1 text-sm normal-case"
				>
					<span class="truncate">{dispositionName(draft.disposition)}</span>
					<span class="shrink-0 text-text-muted" title="Set by your detachment" aria-label="Set by your detachment">🔒</span>
				</div>
			{:else}
				<!-- No mapping in the data yet — manual pick (the project's spine). -->
				<select
					class="bg-panel border-panel-border text-text mt-0.5 rounded border px-1.5 py-1 text-sm"
					value={draft.disposition ?? ''}
					onchange={(e) => (draft.disposition = (e.target as HTMLSelectElement).value || null)}
				>
					<option value="">— unset —</option>
					{#each dispositions as fd (fd.id)}
						<option value={fd.id}>{fd.name}</option>
					{/each}
				</select>
			{/if}
		</label>
		{/if}
		<div class="ml-auto text-right max-lg:w-full">
			<div
				class="font-heading text-lg font-bold tabular-nums {overLimit
					? 'text-amber-400'
					: 'text-text'}"
			>
				{total} / {limit}
			</div>
			<div class="text-xs tabular-nums {overLimit ? 'text-amber-400' : 'text-text-muted'}">
				{overLimit ? `${total - limit} over` : `${limit - total} remaining`}
			</div>
		</div>
	</div>

	{#if armyIssues.length > 0}
		<div class="flex flex-wrap gap-1">
			{#each armyIssues as issue (issue.message)}
				<span class="rounded bg-amber-900/40 px-1.5 py-0.5 text-xs text-amber-200"
					>{issue.message}</span
				>
			{/each}
		</div>
	{/if}

	<!-- The three builder panels live in snippets so they render once and place
	     differently per breakpoint: a desktop 3-column grid, or — on mobile —
	     a full-width roster with the picker and detail panels in bottom sheets. -->
	{#snippet pickerPane()}
		<UnitPicker draft={draft} onadd={addUnit} />
	{/snippet}

	{#snippet rosterPane()}
		{#if draft.units.length === 0}
			<p class="text-text-dim m-auto text-sm italic">
				{draft.factionId
					? viewport.isMobile
						? 'Tap “Add unit” to begin.'
						: 'Add units from the left.'
					: 'Pick a faction to begin.'}
			</p>
		{:else}
			<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
				{#each draftGroups as group (group.key)}
					<div class="flex flex-col gap-1">
						<div
							class="text-text-muted flex items-center gap-2 border-b border-dashed border-white/10 pb-0.5 text-xs font-semibold uppercase tracking-wider"
						>
							<span class="flex-1">{group.label}</span>
							<span class="text-text-muted tabular-nums">{group.units.length}</span>
							<span class="text-text-muted tabular-nums normal-case">{group.points} pts</span>
						</div>
						{#each group.units as u (u.key)}
							<BuilderUnitRow
								unit={u}
								draft={draft}
								selected={u.key === selectedKey}
								onselect={() => selectUnit(u.key)}
								onclone={() => cloneUnit(u.key)}
								onremove={() => removeUnit(u.key)}
							/>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}

	{#snippet detailPane()}
		<UnitDetailPanel
			unit={selected}
			draft={draft}
			onchange={updateUnit}
			onconfiguration={applyConfiguration}
			onwarlord={() => selected && setWarlord(selected.key)}
		/>
	{/snippet}

	{#if viewport.isMobile}
		<!-- Mobile: roster fills the width; picker + detail slide up as sheets.
		     The sheet bodies are scrollable, but each panel is `h-full` with its
		     own inner scroll, so give it a definite height to scroll within. -->
		<button
			type="button"
			class="bg-accent text-accent-foreground hover:bg-accent-hover shrink-0 rounded px-4 py-2.5 text-sm font-semibold uppercase tracking-wide transition-colors disabled:opacity-40"
			disabled={!draft.factionId}
			onclick={() => (pickerOpen = true)}
		>
			＋ Add unit
		</button>
		<div class="bg-panel border-panel-border flex min-h-0 flex-1 flex-col rounded border p-2">
			{@render rosterPane()}
		</div>

		<BottomSheet bind:open={pickerOpen} title="Add unit">
			<div class="h-[68vh]">{@render pickerPane()}</div>
		</BottomSheet>
		<BottomSheet bind:open={detailOpen} title={selected ? selectedName : 'Unit'}>
			<div class="h-[72vh]">{@render detailPane()}</div>
		</BottomSheet>
	{:else}
		<!-- NR 3-column layout: picker (¼) | roster (½) | selected-unit detail (¼).
		     `grid-rows-[minmax(0,1fr)]` bounds the single row to the grid height so each
		     column's inner overflow-y-auto can scroll instead of stretching to content. -->
		<div class="grid min-h-0 flex-1 grid-cols-[1fr_2fr_1fr] grid-rows-[minmax(0,1fr)] gap-2">
			<div class="bg-panel border-panel-border min-h-0 overflow-hidden rounded border p-2">
				{@render pickerPane()}
			</div>
			<div class="bg-panel border-panel-border flex min-h-0 flex-col rounded border p-2">
				{@render rosterPane()}
			</div>
			<div class="bg-panel border-panel-border flex min-h-0 flex-col rounded border p-2">
				{@render detailPane()}
			</div>
		</div>
	{/if}

	<!-- Footer. Save is never disabled — violations are advisory. A doubles
	     army defers save/cancel/share to the team workspace. -->
	{#if !doubles}
		<div class="flex shrink-0 items-center justify-between">
			<button class="text-text-muted hover:text-text text-xs" onclick={oncancel}>Cancel</button>
			<div class="flex items-center gap-2">
				<button
					class="border-panel-border text-text hover:border-panel-border/80 rounded border px-3 py-1.5 text-sm font-medium transition-colors"
					onclick={() => (shareOpen = true)}
				>
					Share
				</button>
				<button
					class="bg-accent text-accent-foreground hover:bg-accent-hover rounded px-4 py-1.5 text-sm font-semibold transition-colors"
					onclick={save}
				>
					Save to Library
				</button>
			</div>
		</div>

		<ShareModal bind:open={shareOpen} roster={shareRoster} draft={shareOpen ? draft : null} />
	{/if}
</div>
