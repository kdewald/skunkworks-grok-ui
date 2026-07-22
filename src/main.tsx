import ReactDOM from "react-dom/client";
import App from "./App";
import { handleExternalAnchorClick } from "./openExternal";

// Note: React StrictMode is intentionally off. It double-invokes effects in
// dev, and with async Tauri `listen()` that previously registered two handlers
// per event — which doubled every stream chunk (I'llI'll explore explore…).

// Safety net: any external <a> (markdown, HTML, etc.) must open in the system
// browser — never navigate the Tauri webview, which has no back button.
document.addEventListener(
  "click",
  (event) => {
    handleExternalAnchorClick(event);
  },
  true,
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
