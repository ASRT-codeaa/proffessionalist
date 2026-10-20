import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { onSessionExpired } from "./services/http";
import { notifySessionExpired } from "./services/videoHttp";
import "./index.css";

// One 401 flow for both transports: when the app's http helper loses the session, the
// video feed's listeners (services/videoHttp.ts) must hear it too, and vice versa —
// each side's AuthContext/bridge subscription clears the session exactly once.
onSessionExpired(notifySessionExpired);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
