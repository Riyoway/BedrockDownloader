import React from "react";
import ReactDOM from "react-dom/client";
import { HeroUIProvider, ToastProvider } from "@heroui/react";
import App from "./App";
import "@south-paw/typeface-minecraft";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HeroUIProvider>
      <ToastProvider placement="bottom-center" toastOffset={12} />
      <main className="dark text-foreground bg-background h-screen">
        <App />
      </main>
    </HeroUIProvider>
  </React.StrictMode>,
);
