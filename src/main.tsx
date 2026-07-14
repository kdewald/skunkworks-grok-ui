import ReactDOM from "react-dom/client";
import App from "./App";

// Note: React StrictMode is intentionally off. It double-invokes effects in
// dev, and with async Tauri `listen()` that previously registered two handlers
// per event — which doubled every stream chunk (I'llI'll explore explore…).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
