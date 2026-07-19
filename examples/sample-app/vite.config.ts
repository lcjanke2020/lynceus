import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    // Disable minification: this is a TEST FIXTURE. The L3 e2e suite
    // evaluates expressions like `count + step` against the running
    // bundle; with esbuild's default name-mangling those become
    // `r + n` in the runtime scope, the debugger can't resolve the
    // original identifiers, and the eval returns NaN. Disabling minify
    // is cheaper than configuring Chrome's source-map name resolution
    // for headless mode AND makes failures easier to read.
    minify: false,
    // The ordinary counter fixture remains the default page. fullstack.html
    // is a second, isolated vanilla entry used only by the dual-session L3
    // flow, so its API request cannot add network noise to existing specs.
    rollupOptions: {
      input: {
        main: resolve(fixtureRoot, "index.html"),
        fullstack: resolve(fixtureRoot, "fullstack.html"),
      },
    },
  },
});
