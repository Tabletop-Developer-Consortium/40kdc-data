/**
 * Report which authored abilities are out of date with respect to their source text.
 *
 *   npm run audit:source-digest -- <corpus.json>
 *
 * <corpus.json> is the contributor's own rules datasource: {ability_id|name: "printed text"}.
 * Nothing is written; the corpus is never copied into the repo. Exit code 1 if any
 * annotation's digest no longer matches, so CI can gate on it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sourceDigest, type SourceDigest } from './source-digest.js';

const corpusPath = process.argv[2];
if (!corpusPath) {
  console.error('usage: audit-source-digest <corpus.json>');
  process.exit(2);
}
const corpus: Record<string, string> = JSON.parse(readFileSync(corpusPath, 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e: string) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('abilities.json') ? [p] : [];
  });
}

let checked = 0, stale = 0, missing = 0, unknown = 0;
for (const file of walk('data/enrichment')) {
  for (const a of JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>) {
    const id = String(a.ability_id);
    const text = corpus[id] ?? corpus[String(a.name)];
    if (text === undefined) { unknown++; continue; }
    const d = a.source_digest as SourceDigest | undefined;
    if (!d) { missing++; continue; }
    checked++;
    if (d.value !== (await sourceDigest(text))) {
      stale++;
      console.log(`STALE  ${id}  authored against ${d.source}; source text has changed since`);
    }
  }
}
console.log(`\nchecked ${checked}; stale ${stale}; no digest recorded ${missing}; not in corpus ${unknown}`);
process.exit(stale ? 1 : 0);
