import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Fonts bundled locally (no CDN) — t3's own stack: DM Sans for UI text,
// JetBrains Mono for the few monospace bits (tool names).
import "@fontsource-variable/dm-sans";
import "@fontsource/jetbrains-mono";

import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
