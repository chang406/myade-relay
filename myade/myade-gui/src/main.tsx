import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import CompanionApp from "./CompanionApp";

// One SPA bundle serves both windows (see commands::open_companion_window).
// Which root component mounts is decided by this window's Tauri label
// ("main" vs "companion", set at WebviewWindowBuilder::new time) rather
// than a URL hash/query string - WebviewUrl::App("index.html#companion")
// was tried first, but a `#`-bearing path fed through Tauri's dev-server
// URL resolution rendered a blank window (nothing loaded, not even a JS
// error), so the window's own identity - which Tauri already tracks and
// exposes via getCurrentWindow().label - is the reliable signal here.
const isCompanion = getCurrentWindow().label === "companion";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isCompanion ? <CompanionApp /> : <App />}</React.StrictMode>,
);
