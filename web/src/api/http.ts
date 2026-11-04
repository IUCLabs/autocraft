import type { Api } from "./client";
import type { DecisionFilter, ItemFilter } from "./types";

/** Query string from the set fields; booleans as 1 / 0. */
function qs(f: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

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

  async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET") {
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

  // Views that mount together often ask for the same thing; they share one request.
  const inflight = new Map<string, Promise<unknown>>();
  const get = <T>(path: string): Promise<T> => {
    let p = inflight.get(path) as Promise<T> | undefined;
    if (!p) {
      p = call<T>("GET", path).finally(() => inflight.delete(path));
      inflight.set(path, p);
    }
    return p;
  };
  async function post<T>(path: string, body?: unknown): Promise<T> {
    const v = await call<T>("POST", path, body);
    changed();
    return v;
  }
  async function put<T>(path: string, body?: unknown): Promise<T> {
    const v = await call<T>("PUT", path, body);
    changed();
    return v;
  }
  const conv = (repo: string, n: number, rest = "") => `/api/conversations/${encodeURIComponent(repo)}/${encodeURIComponent(String(n))}${rest}`;
  const dec = (id: string, rest = "") => `/api/decisions/${encodeURIComponent(id)}${rest}`;

  function query(f: DecisionFilter): string {
    const q = new URLSearchParams();
    if (f.status) q.set("status", f.status);
    if (f.repo?.length) q.set("repo", f.repo.join(","));
    if (f.kind?.length) q.set("kind", f.kind.join(","));
    if (f.minAge) q.set("minAge", String(f.minAge));
    if (f.mine) q.set("mine", "1");
    if (f.limit !== undefined) q.set("limit", String(f.limit));
    if (f.after) q.set("after", f.after);
    if (f.offset !== undefined) q.set("offset", String(f.offset));
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  function itemQuery(f: ItemFilter): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
      q.set(k, Array.isArray(v) ? v.join(",") : typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  return {
    me: () => get("/api/me"),
    repos: () => get("/api/repos"),
    decisions: {
      list: (filter) => get(`/api/decisions${query(filter)}`),
      get: (id) => get(dec(id)),
      forItem: (repo, number, kind) => get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}/decision${qs({ kind })}`),
      answer: (id, input) => post(dec(id, "/answer"), input),
      undo: (id) => post(dec(id, "/undo")),
      reopen: (id) => post(dec(id, "/reopen")),
      feedback: (id, input) => post(dec(id, "/feedback"), input),
      retract: (id) => post(dec(id, "/retract")),
      adopt: (id, opinionId, textsHash) => post(dec(id, "/adopt"), { opinionId, textsHash }),
      // A claim changes nothing anyone is looking at, so open views don't refetch.
      claim: (id) => call("POST", dec(id, "/claim")),
      thread: (id) => get(dec(id, "/thread")),
    },
    release: async (repo, number, action) => {
      await post(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}/${action}`);
    },
    conversations: {
      get: (repo, number) => get(conv(repo, number)),
      say: (repo, number, text) => post(conv(repo, number, "/messages"), { text }),
      editCard: (id, text) => post(`/api/conversation-cards/${id}/edit`, { text }),
      doCard: (id) => post(`/api/conversation-cards/${id}/do`),
      dismissCard: (id) => post(`/api/conversation-cards/${id}/dismiss`),
    },
    areas: {
      get: (repo) => get(`/api/areas/${encodeURIComponent(repo)}`),
      edit: (repo, edit) => post(`/api/areas/${encodeURIComponent(repo)}/edit`, edit),
      run: (repo, step) => post(`/api/areas/${encodeURIComponent(repo)}/run`, { step }),
      accept: (id, body) => post(`/api/area-proposals/${id}/accept`, body ?? {}),
      dismiss: async (id) => {
        await post(`/api/area-proposals/${id}/dismiss`);
      },
    },
    item: (repo, number) => get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}`),
    itemTrace: (repo, number, q = {}) =>
      get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}/trace${qs({ ...q, kinds: q.kinds?.join(",") })}`),
    itemTraceDetail: (repo, number, id) => get(`/api/items/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}/trace/event${qs({ id })}`),
    activity: (q = {}) => get(`/api/activity${qs({ ...q, kinds: q.kinds?.join(",") })}`),
    search: (q) => (q.trim() ? get(`/api/search?${new URLSearchParams({ q })}`) : Promise.resolve([])),
    items: (f) => get(`/api/items${itemQuery(f)}`),
    progress: () => get("/api/progress"),
    mainCi: () => get("/api/main-ci"),
    contributors: {
      list: (filter) => get(`/api/contributors${qs(filter)}`),
      previewRule: (rule) => get(`/api/contributors/rule-preview${qs(rule)}`),
      setRule: (rule) => post("/api/contributors/rule", rule),
      override: (login, input) => post(`/api/contributors/${encodeURIComponent(login)}/override`, input),
    },
    repoAdmin: {
      list: () => get("/api/repos/all"),
      track: (name) => post("/api/repos/track", { name }),
      untrack: (name) => post("/api/repos/untrack", { name }),
      approveMerging: (name, approved) => post(approved ? "/api/repos/merge-approve" : "/api/repos/merge-revoke", { name }),
      singleMerge: () => get("/api/merge/single"),
      setSingleMerge: (max) => put("/api/merge/single", { max }),
      approvePushing: (name, approved) => post(approved ? "/api/repos/push-approve" : "/api/repos/push-revoke", { name }),
      approveCommenting: (name, approved) => post(approved ? "/api/repos/comment-approve" : "/api/repos/comment-revoke", { name }),
      approveFixing: (name, approved) => post(approved ? "/api/repos/fixissue-approve" : "/api/repos/fixissue-revoke", { name }),
      approveMainFixing: (name, approved) => post(approved ? "/api/repos/mainfix-approve" : "/api/repos/mainfix-revoke", { name }),
      setOptionalCheck: (name, check, on) => post(on ? "/api/repos/optional-check-add" : "/api/repos/optional-check-remove", { name, check }),
      setPipeline: (name, on) => post(on ? "/api/repos/pipeline-on" : "/api/repos/pipeline-off", { name }),
      approveLabels: (name, approved) => post(approved ? "/api/repos/labels-approve" : "/api/repos/labels-revoke", { name }),
    },
    access: {
      overview: () => get("/api/access"),
      add: (input) => post("/api/access/add", input),
      remove: (login) => post("/api/access/remove", { login }),
      setRole: (login, role) => post("/api/access/role", { login, role }),
      revokeSession: (id) => post("/api/access/sessions/revoke", { id }),
      audit: (filter) => get(`/api/audit${qs(filter)}`),
    },
    classifiers: {
      report: (sel) => get(`/api/classifiers${qs(sel)}`),
      disagreements: (f) => get(`/api/classifiers/disagreements${qs(f)}`),
    },
    cost: (run) => get(`/api/cost${qs({ run })}`),
    pipeline: {
      overview: () => get("/api/pipeline"),
      jobs: (f) => get(`/api/pipeline/jobs${qs(f)}`),
      job: (id) => get(`/api/pipeline/jobs/${id}`),
      run: (step, params) => post("/api/pipeline/jobs", { step, params }),
      cancel: (id) => post(`/api/pipeline/jobs/${id}/cancel`),
      state: () => get("/api/pipeline/state"),
      setEnabled: (enabled) => put("/api/pipeline/state", { enabled }),
      setLimit: (step, limit) => put(`/api/pipeline/limits/${encodeURIComponent(step)}`, limit),
      resetLimit: (step) => post(`/api/pipeline/limits/${encodeURIComponent(step)}/reset`),
      resumeTrip: (stage) => post(`/api/pipeline/trips/${encodeURIComponent(stage)}/resume`),
      setPilot: (items) => put("/api/pipeline/pilot", { items }),
    },
    accounts: {
      list: () => get("/api/accounts"),
      pause: () => get("/api/accounts/pause"),
      setPause: (input) => put("/api/accounts/pause", input),
      jev: () => get("/api/accounts/jev"),
      setJev: (input) => put("/api/accounts/jev", input),
      update: (id, input) => put(`/api/accounts/${encodeURIComponent(id)}`, input),
      add: (label) => post("/api/accounts", { label }),
      loginStart: (id) => post(`/api/accounts/${encodeURIComponent(id)}/login`),
      loginCode: (id, code) => post(`/api/accounts/${encodeURIComponent(id)}/login/code`, { code }),
      loginCancel: (id) => post(`/api/accounts/${encodeURIComponent(id)}/login/cancel`),
      signOut: (id) => post(`/api/accounts/${encodeURIComponent(id)}/sign-out`),
      refresh: (id) => post(`/api/accounts/${encodeURIComponent(id)}/refresh`),
    },
    envs: {
      list: () => get("/api/envs"),
      create: (input) => post("/api/envs", input),
      update: (id, input) => put(`/api/envs/${encodeURIComponent(id)}`, input),
      rotateKey: (id) => post(`/api/envs/${encodeURIComponent(id)}/rotate-key`),
    },
    tasks: {
      list: (f) => get(`/api/tasks${qs(f)}`),
      get: (id) => get(`/api/tasks/${id}`),
      cancel: (id) => post(`/api/tasks/${id}/cancel`),
      summary: () => get("/api/build/summary"),
    },
    agents: {
      list: (f) => get(`/api/agents${qs(f)}`),
      get: (id) => get(`/api/agents/${id}`),
    },
    rates: (window) => get(`/api/rates${qs({ window })}`),
    prompts: () => get("/api/prompts"),
    queue: (f) => get(`/api/queue${qs(f)}`),
    queueBatches: (f) => get(`/api/queue/batches${qs(f)}`),
    githubActivity: (f) => get(`/api/github-activity${qs(f)}`),
    flow: (repo) => get(`/api/flow${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`),
    async signOut() {
      await call("POST", "/api/signout");
      location.assign("/auth/signed-out");
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    similar: (repo, number, limit) => get(`/api/similar/${encodeURIComponent(repo)}/${encodeURIComponent(String(number))}${qs({ limit })}`),
    semanticSearch: (q) => get(`/api/search?${new URLSearchParams({ q, mode: "semantic" })}`),
    work: (f) => get(`/api/work${qs(f)}`),
    pipelineRepos: () => get("/api/repos/pipeline"),
    fastTrack: () => get("/api/fast-track"),
    heldMerges: () => get("/api/merge/held"),
    queuePage: (f) => get(`/api/queue/page${qs(f)}`),
    queueControl: {
      fastTrackAdd: (item) => post("/api/fast-track", { item }),
      fastTrackRemove: (item) => post("/api/fast-track/remove", { item }),
      hold: async (item) => void (await post("/api/merge/hold", { item })),
      release: async (item) => void (await post("/api/merge/release", { item })),
      batchRemove: async (item) => void (await post("/api/merge/batch-remove", { item })),
      stopBatch: async (id) => void (await post(`/api/queue/batches/${id}/stop`)),
    },
  };
}
