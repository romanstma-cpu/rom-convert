import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";

// App provides the toast host itself, so nothing wraps it here.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
