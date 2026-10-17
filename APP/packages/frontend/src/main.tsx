import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/foundation.css";
import "./styles/shell.css";
import "./styles/home.css";
import "./styles/create.css";
import "./styles/workspace.css";
import "./styles/interface.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Missing root element");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
