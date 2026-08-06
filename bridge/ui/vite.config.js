import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev-only proxy: the bridge's Express server (bridge/src/server.ts) owns
// /api, /artifacts and /mcp. Point BRIDGE_DEV_TARGET at it (default matches
// the bridge's own default port) so `npm run dev` here works standalone.
// `npm run build` → dist/, which the bridge serves as static files in prod;
// no proxy involved there.
const devProxyTarget = process.env.BRIDGE_DEV_TARGET || "http://127.0.0.1:4821";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 7180,
    proxy: {
      "/api": devProxyTarget,
      "/artifacts": devProxyTarget,
      "/art": devProxyTarget,
      "/mcp": devProxyTarget,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
