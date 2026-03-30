import { createValidator } from "../schema-loader.js";
import { validateFiles } from "../validate.js";
import { formatReport, type ReporterMode } from "../report.js";

export async function validateCoreCommand(opts: { reporter: string }): Promise<void> {
  const ajv = createValidator();
  const result = await validateFiles(ajv, "core/**/*.json");
  const output = formatReport(result, opts.reporter as ReporterMode);
  console.log(output);
  if (result.failed > 0) {
    process.exit(1);
  }
}
