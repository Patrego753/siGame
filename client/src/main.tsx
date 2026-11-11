import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

const app = (
  <BrowserRouter>
    <App />
  </BrowserRouter>
);

/** В production StrictMode даёт лишний mount/unmount → обрыв сокета и гонки с join. */
ReactDOM.createRoot(document.getElementById("root")!).render(
  import.meta.env.DEV ? <React.StrictMode>{app}</React.StrictMode> : app,
);
