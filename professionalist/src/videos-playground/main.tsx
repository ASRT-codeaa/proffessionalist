import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./playground.css";
import { PlaygroundApp } from "./PlaygroundApp";

/**
 * Entry point for the videos subtree ONLY. `vite.videos.config.ts` builds this file; the
 * production app never imports anything in src/videos-playground/.
 */
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <PlaygroundApp />
  </StrictMode>,
);
