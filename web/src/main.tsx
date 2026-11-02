import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Tooltip } from "radix-ui";
import "./styles/app.css";
import { ApiContext } from "./api/client";
import { createMockApi } from "./api/mock/mockApi";
import type { User } from "./api/types";
import { UserContext } from "./shell/UserContext";
import { AppShell } from "./shell/AppShell";
import { initTheme } from "./shell/theme";

initTheme();

// The mock serves fixture data until the server exposes the JSON API.
const api = createMockApi();

function App() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => void api.me().then(setUser), []);
  if (!user) return null;
  return (
    <ApiContext.Provider value={api}>
      <UserContext.Provider value={user}>
        <Tooltip.Provider delayDuration={300}>
          <BrowserRouter>
            <AppShell />
          </BrowserRouter>
        </Tooltip.Provider>
      </UserContext.Provider>
    </ApiContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
