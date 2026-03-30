import { createValidator } from "../schema-loader.js";
import { validateFiles } from "../validate.js";
import { formatReport, type ReporterMode } from "../report.js";
import type { ValidationResult } from "../validate.js";

export async function validateAllCommand(opts: { reporter: string }): Promise<void> {
  const ajv = createValidator();

  const coreResult = await validateFiles(ajv, "core/**/*.json");
  const enrichmentResult = await validateFiles(ajv, "enrichment/**/*.json");

  const combined: ValidationResult = {
    totalFiles: coreResult.totalFiles + enrichmentResult.totalFiles,
    totalItems: coreResult.totalItems + enrichmentResult.totalItems,
    passed: coreResult.passed + enrichmentResult.passed,
    failed: coreResult.failed + enrichmentResult.failed,
    errors: [...coreResult.errors, ...enrichmentResult.errors],
  };

  const output = formatReport(combined, opts.reporter as ReporterMode);
  console.log(output);
  if (combined.failed > 0) {
    process.exit(1);
  }
}
