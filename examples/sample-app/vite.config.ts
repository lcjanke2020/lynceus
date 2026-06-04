import { defineConfig } from "vite";

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
  },
});
