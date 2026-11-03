// Client of the coordinator's worker API. The key goes only into the
// Authorization header; errors carry the path and status, never the key.
import type { SandboxInfo } from "./environment.ts";
import type { Capabilities, ClaimResponse, StepResult } from "./types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, path: string, detail: string) {
    super(`${path}: HTTP ${status}${detail ? ` ${detail}` : ""}`);
    this.status = status;
  }
}

export class WorkerApi {
  #base: string;
  #key: string;
  #fetch: typeof fetch;
  constructor(base: string, key: string, fetchImpl: typeof fetch = fetch) {
    this.#base = base.replace(/\/+$/, "");
    this.#key = key;
    this.#fetch = fetchImpl;
  }

  async #call<T>(method: string, path: string, body?: Buffer | object, contentType = "application/json"): Promise<T> {
    const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#key}`, ...(raw === undefined ? {} : { "content-type": contentType }) },
        body: raw as BodyInit | undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new Error(`${path}: ${(e as Error).name}: ${(e as Error).message}`.replaceAll(this.#key, "***"));
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, path, text.slice(0, 200).replaceAll(this.#key, "***"));
    return (text ? JSON.parse(text) : {}) as T;
  }

  hello(version: string, capabilities: Capabilities, slots: number) {
    return this.#call<{ envId: string; label: string }>("POST", "/worker/hello", { version, capabilities, slots });
  }
  claim(free: number, pausedReason: string | null) {
    return this.#call<ClaimResponse>("POST", "/worker/claim", { free, pausedReason });
  }
  start(id: number) {
    return this.#call<object>("POST", `/worker/tasks/${id}/start`, {});
  }
  log(id: number, step: string, chunk: string) {
    return this.#call<object>("POST", `/worker/tasks/${id}/log`, { step, chunk });
  }
  heartbeat(id: number) {
    return this.#call<{ cancel?: number[] }>("POST", `/worker/tasks/${id}/heartbeat`, {});
  }
  upload(id: number, name: string, body: Buffer, contentType: string) {
    return this.#call<object>("PUT", `/worker/tasks/${id}/artifacts/${encodeURIComponent(name)}`, body, contentType);
  }
  finish(id: number, results: StepResult[], summary: string, environment?: SandboxInfo) {
    return this.#call<object>("POST", `/worker/tasks/${id}/finish`, { results, summary, ...(environment ? { environment } : {}) });
  }
}
