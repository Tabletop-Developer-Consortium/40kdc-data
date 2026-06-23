/**
 * Substitute a locally-entered player/team name into an ATC-2026 export.
 *
 * The package emits the ATC header with `+ PLAYER NAME: —` / `+ TEAM NAME: —`
 * placeholders (it never stores personal data). This app-only helper rewrites
 * those two lines with the user's entered values for the copied text — keeping the
 * names out of the Roster, share token, and cloud upload entirely. A blank value
 * leaves the package's em-dash; non-ATC formats pass through verbatim.
 */
import type { ExportFormat } from '@alpaca-software/40kdc-data';

export function isAtcFormat(format: ExportFormat): boolean {
	return format.startsWith('atc-2026');
}

/** Inputs are single-line; collapse any stray newlines and trim. */
function clean(value: string): string {
	return value.replace(/[\r\n]+/g, ' ').trim();
}

function substituteLine(text: string, label: string, value: string): string {
	const v = clean(value);
	if (!v) return text;
	return text.replace(new RegExp(`^\\+ ${label}: .*$`, 'm'), `+ ${label}: ${v}`);
}

export function applyAtcIdentity(
	text: string,
	format: ExportFormat,
	id: { playerName: string; teamName: string },
): string {
	if (!isAtcFormat(format)) return text;
	return substituteLine(substituteLine(text, 'PLAYER NAME', id.playerName), 'TEAM NAME', id.teamName);
}
