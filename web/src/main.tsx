import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Tooltip } from "radix-ui";
import { disableGlobalCursorStyles } from "react-resizable-panels";
import "./styles/app.css";
import { ApiContext, type Api } from "./api/client";
import { createHttpApi } from "./api/http";
import type { User } from "./api/types";
import { UserContext } from "./shell/UserContext";
import { AppShell } from "./shell/AppShell";
import { initTheme } from "./shell/theme";

initTheme();
// The panels library would set the drag cursor with an injected <style>, which
// the server's CSP refuses; the resize handles set their own cursor.
disableGlobalCursorStyles();

// `VITE_MOCK=1` builds the fake-data mockup, which runs without a server.
const loadApi = async (): Promise<Api> =>
  import.meta.env.VITE_MOCK === "1" ? (await import("./api/mock/mockApi")).createMockApi() : createHttpApi();

function App({ api }: { api: Api }) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.me().then(setUser, (e: Error) => setError(e.message)), [api]);
  if (error) return <div className="p-8 text-ink/60">The dashboard could not load: {error}</div>;
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

void loadApi().then((api) =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  ),
);
