import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_MECHANIC_GRAPH_PROXY_TARGET || "http://127.0.0.1:4310";

  return {
    plugins: [svelte()],
    server: {
      host: "127.0.0.1",
      port: 4293,
      strictPort: true,
      proxy: { "/api": { target: proxyTarget } },
    },
    preview: {
      host: "127.0.0.1",
      port: 4293,
      strictPort: true,
      proxy: { "/api": { target: proxyTarget } },
    },
  };
});
