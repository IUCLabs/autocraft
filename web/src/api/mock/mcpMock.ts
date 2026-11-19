import type { Api } from "../client";
import type { InferenceSettings, McpToken, MySettings, RemoteHelper, User } from "../types";
import { NOW } from "./fixtures";

const DAY = 86_400_000;

/** The Connect page's tokens, in memory; the server's rules (at most five, own tokens only) apply. */
export function createMcpMock(me: User, changed: () => void): Pick<Api, "mcp" | "inference" | "remote"> & { meSettings: Api["me"]["settings"] } {
  let inference: InferenceSettings = { mode: me.inference, models: { top: ["opus", "astra"], mid: ["sonnet"], small: ["haiku"] } };
  let settings: MySettings = { reserve: { fiveHour: 20, weekly: 10 } };
  const helpers: RemoteHelper[] = [
    { tokenId: 2, label: "laptop", readiness: "ready", until: null, harness: "claude", models: { top: "opus", mid: "sonnet", small: "haiku" }, usage: { fiveHour: 42, weekly: 18 }, lastSeen: new Date(NOW - 40_000).toISOString() },
    { tokenId: 3, label: "workstation", readiness: "quota-held", until: new Date(NOW + 95 * 60_000).toISOString(), harness: "codex", models: { top: "astra", mid: "astra-mini", small: "astra-mini" }, usage: { fiveHour: 83, weekly: 61 }, lastSeen: new Date(NOW - 4 * 60_000).toISOString() },
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
        inference = { mode: body.mode ?? inference.mode, models: body.models ?? inference.models };
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
        if (!ok(body.reserve.fiveHour) || !ok(body.reserve.weekly)) throw new Error("keep-free values are whole numbers from 0 to 90");
        settings = structuredClone(body);
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
