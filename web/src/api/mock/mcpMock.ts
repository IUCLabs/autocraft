import type { Api } from "../client";
import type { InferenceSettings, McpToken, MySettings, RemoteHelper, User } from "../types";
import { NOW } from "./fixtures";

const DAY = 86_400_000;

/** The Connect page's tokens, in memory; the server's rules (at most five, own tokens only) apply. */
export function createMcpMock(me: User, changed: () => void): Pick<Api, "mcp" | "inference" | "remote"> & { meSettings: Api["me"]["settings"] } {
  let inference: InferenceSettings = { mode: me.inference, models: { top: ["opus", "astra"], mid: ["sonnet"], small: ["haiku"] }, minEffort: { top: "high" } };
  let settings: MySettings = { reserve: { fiveHour: 20, weekly: 10 }, maxCalls: null, repos: ["designcraft", "photocraft", "textcraft"], repoChoices: ["designcraft", "fontcraft", "gridcraft", "photocraft", "wordcraft"] };
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  const helpers: RemoteHelper[] = [
    { tokenId: 2, label: "laptop", readiness: "ready", until: null, reason: null, fresh: true, lastSeen: at(-40_000), slots: 3, busy: 1, lastError: null, harness: "claude", models: { top: "opus", mid: "sonnet", small: "haiku" }, reserve: { fiveHour: 20, weekly: 10 },
      usage: { fiveHour: { usedPercent: 42, resetsAt: at(3 * 3600_000) }, weekly: { usedPercent: 18, resetsAt: at(4 * DAY) }, at: at(-40_000) } },
    { tokenId: 3, label: "workstation", readiness: "quota-held", until: at(95 * 60_000), reason: "5-hour window 83% used (reserve 20% free)", fresh: true, lastSeen: at(-4 * 60_000), slots: 2, busy: 0, lastError: null, harness: "codex", models: { top: "astra", mid: "astra-mini", small: "astra-mini" }, reserve: { fiveHour: 20, weekly: 10 },
      usage: { fiveHour: { usedPercent: 83, resetsAt: at(95 * 60_000) }, weekly: { usedPercent: 61, resetsAt: at(2 * DAY) }, at: at(-4 * 60_000) } },
    { tokenId: 4, label: "mini", readiness: "cooled-off", until: at(5 * 3600_000), reason: "its leases were lost 3 times within 2 hours (no heartbeat, or past the call's time limit)", fresh: true, lastSeen: at(-90_000), slots: 5, busy: 0, lastError: { text: "submit: HTTP 502 from the server; retrying", at: at(-30 * 60_000) }, harness: "claude", models: { top: "opus", mid: "sonnet", small: "haiku" }, reserve: { fiveHour: 20, weekly: 10 },
      usage: { fiveHour: { usedPercent: 12, resetsAt: at(4 * 3600_000) }, weekly: { usedPercent: 30, resetsAt: at(4 * DAY) }, at: at(-90_000) } },
  ];
  let next = 3;
  let tokens: McpToken[] = [
    { id: 2, label: "laptop", canAnswer: false, canRun: true, createdAt: new Date(NOW - 3 * DAY).toISOString(), lastUsedAt: new Date(NOW - 40 * 60_000).toISOString(), expiresAt: new Date(NOW + 87 * DAY).toISOString() },
  ];
  const list = () => ({ tokens: structuredClone(tokens), max: 5, path: "/mcp", answering: false });
  const wait = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));
  return {
    inference: {
      get: () => wait(structuredClone(inference)),
      async put(body) {
        if (me.role !== "operator") throw new Error("only operators change the inference mode");
        const minEffort = { ...inference.minEffort };
        for (const [t, e] of Object.entries(body.minEffort ?? {})) {
          if (e === null) delete minEffort[t as keyof typeof minEffort];
          else minEffort[t as keyof typeof minEffort] = e;
        }
        inference = { mode: body.mode ?? inference.mode, models: body.models ?? inference.models, minEffort };
        me.inference = inference.mode;
        changed();
        return wait(structuredClone(inference));
      },
    },
    meSettings: {
      get: () => wait(structuredClone(settings)),
      async put(body) {
        if (me.role === "viewer") throw new Error("viewers have no settings");
        const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= 90;
        if (body.reserve && (!ok(body.reserve.fiveHour) || !ok(body.reserve.weekly))) throw new Error("keep-free values are whole numbers from 0 to 90");
        settings = { ...settings, ...structuredClone(body), ...(body.repos && { repos: [...new Set(body.repos)].sort() }) };
        changed();
        return wait(structuredClone(settings));
      },
    },
    remote: { helpers: () => wait({ helpers: structuredClone(helpers) }) },
    mcp: {
      tokens: () => wait(list()),
      async create(label, answer = false, run = false) {
        if (me.role === "viewer") throw new Error("viewers cannot make agent tokens");
        if (answer) throw new Error("answering from an agent is not available yet");
        if (tokens.length >= 5) throw new Error("you have 5 tokens; revoke one first");
        const id = next++;
        tokens = [{ id, label: label.trim() || null, canAnswer: answer, canRun: run, createdAt: new Date(NOW).toISOString(), lastUsedAt: null, expiresAt: new Date(NOW + (answer ? 7 : 90) * DAY).toISOString() }, ...tokens];
        changed();
        return wait({ ...list(), id, token: `acmcp_mock${id}${"x".repeat(36)}` });
      },
      async revoke(id) {
        if (!tokens.some((t) => t.id === id)) throw new Error("you have no such token");
        tokens = tokens.filter((t) => t.id !== id);
        changed();
        return wait(list());
      },
    },
  };
}
