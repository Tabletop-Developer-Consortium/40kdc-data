/**
 * Player / team identity for the ATC export — a global, **local-only** setting.
 *
 * These names are the same across every list the user builds and are personal, so
 * they live here (one localStorage key) rather than on any roster. They are NEVER
 * written into a Roster, the share token, or a cloud upload — only substituted into
 * the ATC export text the user copies (see `atc-identity.ts`). Kept as a Svelte-5
 * rune so the ShareModal export preview re-derives as the user types.
 */
const KEY = 'list-builder:identity';

function load(): { playerName: string; teamName: string } {
	try {
		const p = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		return { playerName: p.playerName ?? '', teamName: p.teamName ?? '' };
	} catch {
		return { playerName: '', teamName: '' };
	}
}

export const identity = $state(load());

// Persist on any change (matches App.svelte's silent-fail-on-quota convention).
$effect.root(() => {
	$effect(() => {
		try {
			localStorage.setItem(KEY, JSON.stringify({ playerName: identity.playerName, teamName: identity.teamName }));
		} catch {
			/* quota or private mode — identity is a convenience, not load-bearing */
		}
	});
});
