/// <reference types="svelte" />
/// <reference types="vite/client" />

// Footer staleness stamp, injected by Vite's `define` (see vite.config.ts and
// _shared/build-stamp.ts): bundled dataset version and build commit.
declare const __DATA_VERSION__: string;
declare const __BUILD_SHA__: string;
