import { describe, it, expect } from "vitest";
import { createValidator } from "../src/schema-loader.js";
import { validateFiles } from "../src/validate.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures");
const EXAMPLE_DATA_DIR = resolve(__dirname, "../../data");

describe("validate", () => {
  it("validates valid core example data without errors", async () => {
    const ajv = createValidator();
    const result = await validateFiles(ajv, "core/**/*.json", EXAMPLE_DATA_DIR);
    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(0);
  });

  it("validates valid enrichment example data without errors", async () => {
    const ajv = createValidator();
    const result = await validateFiles(ajv, "enrichment/**/*.json", EXAMPLE_DATA_DIR);
    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(0);
  });

  it("validates valid fixture files without errors", async () => {
    const ajv = createValidator();
    const result = await validateFiles(ajv, "valid/**/*.json", FIXTURES_DIR);
    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(0);
  });

  it("rejects invalid fixture files", async () => {
    const ajv = createValidator();
    const result = await validateFiles(ajv, "invalid/**/*.json", FIXTURES_DIR);
    expect(result.failed).toBeGreaterThan(0);
  });

  it("reports correct error count for invalid data", async () => {
    const ajv = createValidator();
    const result = await validateFiles(ajv, "invalid/factions-bad.json", FIXTURES_DIR);
    // Each invalid item should produce at least one error
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
