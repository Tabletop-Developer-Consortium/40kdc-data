<script lang="ts">
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import type { GraphStore } from "./graph-store.svelte.js";
  import GraphSurface from "./GraphSurface.svelte";

  let { store }: { store: GraphStore } = $props();
</script>

<section class="graph-canvas" aria-label="Campaign mechanic evidence graph">
  <SvelteFlowProvider>
    <GraphSurface {store} />
  </SvelteFlowProvider>
</section>

<style>
  .graph-canvas {
    min-width: 0;
    min-height: 0;
  }

  .graph-canvas :global(.graph-surface) {
    width: 100%;
    height: 100%;
  }
</style>
