import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-server only, on purpose: the demo (and the React DevTools work) needs
// React's development build — production builds strip component names from
// the fiber tree. There is no `build` script; run `npm run dev`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
