import type { Api } from "./client";
import type { DecisionFilter } from "./types";

const CSRF_HEADER = "X-CSRF-Token";

function signIn(): never {
  location.assign(`/auth/signin?${new URLSearchParams({ return_to: location.pathname + location.search })}`);
  throw new Error("Your session has ended. Signing in again.");
}

/** The dashboard API over fetch, same origin, with the session cookie. */
export function createHttpApi(): Api {
  let csrf: string | null = null;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") {
      // Every /api/ response carries the session's token; a POST before any GET fetches it first.
      if (!csrf) await call("GET", "/api/me");
      headers[CSRF_HEADER] = csrf ?? "";
      if (body !== undefined) headers["content-type"] = "application/json";
    }
    const r = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
    const token = r.headers.get(CSRF_HEADER);
    if (token) csrf = token;
    if (r.status === 401) signIn();
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try {
        const j = (await r.json()) as { error?: unknown };
        if (typeof j.error === "string") msg = j.error;
      } catch {
        /* not JSON: keep the status line */
      }
      throw new Error(msg);
    }
    if (r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }

  const get = <T>(path: string) => call<T>("GET", path);
  async function post<T>(path: string, body?: unknown): Promise<T> {
    const v = await call<T>("POST", path, body);
    changed();
    return v;
  }
  const dec = (id: string, rest = "") => `/api/decisions/${encodeURIComponent(id)}${rest}`;

  function query(f: DecisionFilter): string {
    const q = new URLSearchParams();
    if (f.status) q.set("status", f.status);
    if (f.repo?.length) q.set("repo", f.repo.join(","));
    if (f.kind?.length) q.set("kind", f.kind.join(","));
    if (f.minAge) q.set("minAge", String(f.minAge));
    if (f.mine) q.set("mine", "1");
    if (f.limit !== undefined) q.set("limit", String(f.limit));
    if (f.offset !== undefined) q.set("offset", String(f.offset));
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  const qs = (o: object) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : "";
  };

  return {
    me: () => get("/api/me"),
    repos: () => get("/api/repos"),
    decisions: {
      list: (filter) => get(`/api/decisions${query(filter)}`),
      get: (id) => get(dec(id)),
      answer: (id, input) => post(dec(id, "/answer"), input),
      undo: (id) => post(dec(id, "/undo")),
      opine: (id, input) => post(dec(id, "/opinion"), input),
      retract: (id) => post(dec(id, "/retract")),
      adopt: (id, opinionId) => post(dec(id, "/adopt"), { opinionId }),
      // A claim changes nothing anyone is looking at, so open views don't refetch.
      claim: (id) => call("POST", dec(id, "/claim")),
      thread: (id) => get(dec(id, "/thread")),
      comment: (id, body) => post(dec(id, "/comments"), { body }),
    },
    item: (repo, number) => get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}`),
    search: (q) => get(`/api/search?${new URLSearchParams({ q })}`),
    progress: () => get("/api/progress"),
    classifiers: {
      report: (sel) => get(`/api/classifiers${qs(sel)}`),
      disagreements: (f) => get(`/api/classifiers/disagreements${qs(f)}`),
    },
    cost: (run) => get(`/api/cost${qs({ run })}`),
    async signOut() {
      await call("POST", "/api/signout");
      location.assign("/auth/signed-out");
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
