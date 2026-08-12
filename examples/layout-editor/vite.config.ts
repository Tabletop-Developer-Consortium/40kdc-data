import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { projectBattlemaster, type BattlemasterProjection } from "../../tools/src/project-battlemaster.js";
import { buildSha, dataPackageVersion } from "../_shared/build-stamp.js";

/**
 * The 40kdc-data package's barrel re-exports schema-loader and validate, which
 * touch `node:fs`/`node:url` at module-load time. This widget never calls them,
 * but Rollup still has to resolve the imports. Stub them out for the browser
 * bundle. (Lifted verbatim from examples/salvo.)
 */
function stubNodeOnlyModules(): Plugin {
  const stubbed = ["node:fs", "node:fs/promises", "node:path", "node:url"];
  return {
    name: "layout-editor:stub-node-only-modules",
    enforce: "pre",
    resolveId(id) {
      // Real polyfill: ListForge URLs are gzipped — route node:zlib's
      // gunzipSync through fflate for browser builds.
      if (id === "node:zlib") return "\0mm-stub:node:zlib";
      if (stubbed.includes(id)) return "\0mm-stub:" + id;
      // Also stub the schema-loader + validate modules from the 40kdc-data
      // package — they pull in fs/path at top level and are useless in the
      // browser. Match by name but only when reached via the package (either
      // through the workspace symlink or directly through tools/dist).
      const isPackageNodeOnly =
        (id.endsWith("/schema-loader.js") ||
          (id.endsWith("/validate.js") && !id.includes("node_modules/svelte/")) ||
          id.endsWith("/bundle-schemas.js")) &&
        (id.includes("/tools/dist/") ||
          id.includes("/@alpaca-software/40kdc-data/"));
      if (isPackageNodeOnly) return "\0mm-stub:empty";
      return null;
    },
    load(id) {
      if (id === "\0mm-stub:node:zlib") {
        return `
          import { gunzipSync as fflateGunzip } from "fflate";
          export const gunzipSync = (buf) => fflateGunzip(new Uint8Array(buf));
        `;
      }
      if (!id.startsWith("\0mm-stub:")) return null;
      // A minimal CommonJS-style stub that returns undefined for any property.
      return `
        const handler = { get: () => () => { throw new Error("Node-only module not available in browser"); } };
        export default new Proxy({}, handler);
        export const fileURLToPath = (u) => String(u);
        export const URL = globalThis.URL;
        export const dirname = (p) => p.replace(/\\/[^/]*$/, "");
        export const resolve = (...parts) => parts.join("/");
        export const join = (...parts) => parts.join("/");
        export const readFileSync = () => "";
        export const existsSync = () => false;
        export const readdirSync = () => [];
        export const statSync = () => ({ isFile: () => false, isDirectory: () => false });
        export const lstatSync = statSync;
        export const writeFileSync = () => {};
        export const mkdtempSync = () => "";
        export const mkdirSync = () => "";
        export const rmSync = () => {};
        export const tmpdir = () => "";
        export const createValidator = () => { throw new Error("createValidator is not available in the browser"); };
        export const findSchemaFiles = () => [];
        export const listSchemaIds = () => [];
        export const SCHEMAS_ROOT = "";
      `;
    },
  };
}

/** Local authoring endpoint for the read-only Battlemaster projection. The
 * browser never receives Steam/BSON/Lua plumbing; it receives canonical shapes. */
function battlemasterProjection(): Plugin {
  let projection: Promise<BattlemasterProjection> | null = null;
  return {
    name: "layout-editor:battlemaster-projection",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__battlemaster-projection", async (_request, response) => {
        try {
          projection ??= projectBattlemaster();
          const payload = await projection;
          response.statusCode = 200;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify(payload));
        } catch (error) {
          projection = null;
          response.statusCode = 502;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [stubNodeOnlyModules(), battlemasterProjection(), svelte()],
  base: process.env.TOOLLET_BASE ?? "/",
  define: {
    // Footer staleness stamp: bundled dataset version + build commit.
    __DATA_VERSION__: JSON.stringify(dataPackageVersion(import.meta.url)),
    __BUILD_SHA__: JSON.stringify(buildSha()),
  },
});
