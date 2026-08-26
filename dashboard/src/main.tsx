import { render } from "preact";
import { App } from "./App";
import { ToastProvider } from "./toast";
import "./styles.css";

render(
  <ToastProvider>
    <App />
  </ToastProvider>,
  document.getElementById("root")!,
);
