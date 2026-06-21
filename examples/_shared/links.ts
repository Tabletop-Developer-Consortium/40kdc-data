/**
 * Canonical external links for the example apps. Every example is deployed to
 * its own subdomain, so cross-app and landing-page hops are absolute URLs —
 * a relative path can't leave the origin.
 */
export const HOME_URL = "https://40kdc.alpacasoft.dev";
export const REPO_URL = "https://github.com/wn-mitch/40kdc-data";
export const PACKAGE_URL = "https://www.npmjs.com/package/@alpaca-software/40kdc-data";
export const PACKAGE_NAME = "@alpaca-software/40kdc-data";
export const PUBLISHER_URL = "https://alpacasoft.dev";
export const PATREON_URL = "https://www.patreon.com/c/AlpacaSoftware";

/** Deployed example apps (package.json homepage values). */
export const SALVO_URL = "https://salvo.alpacasoft.dev";
export const MISSION_MATRIX_URL = "https://mission-matrix.alpacasoft.dev";
export const LAYOUT_EDITOR_URL = "https://layout-editor.alpacasoft.dev";
export const LIST_BUILDER_URL = "https://list-builder.alpacasoft.dev";
export const HULL_TRACER_URL = "https://hull-tracer.alpacasoft.dev";
export const TEAMS_PLANNER_URL = "https://teams-planner.alpacasoft.dev";
export const DATA_EXPLORER_URL = "https://data-explorer.alpacasoft.dev";

/**
 * The example-app family, one ordered source of truth for the header app
 * switcher. `id` matches each app's package.json name; layout-editor's Viewer
 * and Editor share the `layout-editor` id under the viewer-facing label.
 */
export type AppEntry = { id: string; label: string; tag: string; url: string };
export const APPS: AppEntry[] = [
  { id: "salvo", label: "Salvo", tag: "damage calculator", url: SALVO_URL },
  { id: "list-builder", label: "List Builder", tag: "army lists", url: LIST_BUILDER_URL },
  { id: "mission-matrix", label: "Mission Matrix", tag: "WTC scoresheet", url: MISSION_MATRIX_URL },
  { id: "layout-editor", label: "Terrain Layouts", tag: "mission pairings", url: LAYOUT_EDITOR_URL },
  { id: "teams-planner", label: "Teams Planner", tag: "disposition coverage", url: TEAMS_PLANNER_URL },
  { id: "hull-tracer", label: "Hull Tracer", tag: "collision outlines", url: HULL_TRACER_URL },
  { id: "data-explorer", label: "Data Explorer", tag: "dataset browser", url: DATA_EXPLORER_URL },
];

/** The family minus the current app, for cross-app navigation. */
export const siblingApps = (currentId: string): AppEntry[] =>
  APPS.filter((a) => a.id !== currentId);
