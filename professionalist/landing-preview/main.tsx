import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import LandingPage from "@/pages/LandingPage";
import "./entry.css";

// Harness mount: the page needs a router context for its <Link> elements.
// MemoryRouter (not BrowserRouter) so it runs outside the real app shell.
const container = document.getElementById("root");
if (!container) throw new Error("landing preview: #root missing");

createRoot(container).render(
  <StrictMode>
    <MemoryRouter initialEntries={["/"]}>
      <LandingPage />
    </MemoryRouter>
  </StrictMode>,
);
