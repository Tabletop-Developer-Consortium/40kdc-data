/**
 * Intake Battlemaster's 11e Chapter Approved terrain-layout geometry into
 * `data/core/terrain-layouts.json`.
 *
 * ## Why
 *
 * 44 of the repo's 45 Chapter Approved layouts carried `source: "custom"` because
 * they came out of `tools/extract-terrain-layouts.py`, which recovers placements by
 * calibrating per-xref image-stamp CTMs from the GW Event Companion PDF. That got
 * positions roughly right but rotations wrong, and it predates nubbed footprints
 * being in the template catalog — so nub-aware centroids were never accounted for.
 * Battlemaster authors the same 45 cards against the physical terrain, and
 * publishes them through its public TTS Map API (see `battlemaster/source.ts` for
 * why that API and not the documented-but-undeployed Embed API).
 *
 * Only geometry is taken. Card identity — `id`, `name`, `mission_matchup_id`,
 * `variant`, `deployment_pattern_id`, `game_version` — is already correct in the
 * repo and is preserved verbatim; the intake asserts agreement rather than
 * overwriting it, so an upstream card-set change fails loudly instead of silently
 * relabelling our cards.
 *
 * ## Subcommands (from `tools/`)
 *
 *   npx tsx src/ingest-battlemaster-layouts.ts fetch        # snapshot the API
 *   npx tsx src/ingest-battlemaster-layouts.ts calibrate    # learn the conversion
 *   npx tsx src/ingest-battlemaster-layouts.ts map-parts    # learn part → template
 *   npx tsx src/ingest-battlemaster-layouts.ts extract      # dry run + report
 *   npx tsx src/ingest-battlemaster-layouts.ts extract --write
 *   npx tsx src/ingest-battlemaster-layouts.ts verify       # post-write invariants
 *
 * `fetch` is the only networked step; everything else reads the gitignored
 * `_private/battlemaster/` snapshot, so the ingest is reproducible offline and CI
 * never makes an outbound request.
 */
import { fetchSnapshot, loadSnapshot } from "./battlemaster/source.js";
import { calibrate, formatCalibrationReport } from "./battlemaster/calibrate.js";
import { learnPartMapping, formatPartMappingReport } from "./battlemaster/parts.js";
import { runExtract } from "./battlemaster/extract.js";
import { runVerify } from "./battlemaster/verify.js";
import { loadRepoLayouts, loadRepoTemplates } from "./battlemaster/repo.js";

const USAGE = `Usage: ingest-battlemaster-layouts <fetch|calibrate|map-parts|extract|verify> [--write]

  fetch       Snapshot the Battlemaster public TTS API into _private/battlemaster/.
  calibrate   Learn the coordinate/rotation/anchor conversion; assert it is clean.
  map-parts   Learn Battlemaster part -> 40kdc feature-template mapping.
  extract     Project the snapshot into terrain-layouts.json (dry run by default).
  verify      Re-resolve the committed layouts and check the intake invariants.

Options:
  --write     extract only: persist after the projected dataset validates.
  --owner <u> fetch only: Battlemaster owner to snapshot (default: superwutz).
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const write = argv.includes("--write");
  const ownerIdx = argv.indexOf("--owner");
  const owner = ownerIdx >= 0 ? argv[ownerIdx + 1] : undefined;

  switch (sub) {
    case "fetch":
      await fetchSnapshot(owner);
      return;

    case "calibrate": {
      const cal = calibrate(loadSnapshot(), loadRepoLayouts(), loadRepoTemplates());
      console.log(formatCalibrationReport(cal));
      if (!cal.ok) process.exit(1);
      return;
    }

    case "map-parts": {
      const snapshot = loadSnapshot();
      const mapping = learnPartMapping(snapshot, loadRepoLayouts(), loadRepoTemplates());
      console.log(formatPartMappingReport(snapshot, mapping));
      if (!mapping.ok) process.exit(1);
      return;
    }

    case "extract":
      await runExtract({ write });
      return;

    case "verify":
      runVerify();
      return;

    default:
      console.error(USAGE);
      process.exit(sub === undefined || sub === "--help" || sub === "-h" ? 0 : 1);
  }
}

main().catch((e: unknown) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
