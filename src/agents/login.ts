// Signing an account in from the dashboard. `claude auth login --claudeai` runs
// hidden in a pseudo-terminal (util-linux `script`, since the CLI wants a tty),
// prints a sign-in URL, and waits for the code the operator gets from that page.
// `claude setup-token` goes through the same steps and then prints a long-lived
// token, which is handed to `onToken` and cut out of the buffered output.
// The code and the token are secrets: never logged, stored (the token only by
// `onToken`) or echoed, and none of the command's output leaves this process
// except the URL.
import { spawn, type ChildProcess } from "node:child_process";
import { claudeBin } from "./box.ts";
import { childEnv } from "./status.ts";
import { extractToken } from "./token.ts";

export type LoginState = "starting" | "waiting" | "checking" | "done" | "failed" | "cancelled";
/** "login": the regular sign-in; "token": a long-lived token from `claude setup-token`. */
export type LoginKind = "login" | "token";
export type LoginInfo = { state: LoginState; url: string | null; message: string | null; kind: LoginKind };

export const LOGIN_CODE = /^[A-Za-z0-9#_.~+/=-]{1,512}$/;
const LOGIN_URL = /https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/;
const LOGIN_OK = /login successful|successfully logged in|logged in as/i;
const LOGIN_FAILED = /error|failed|invalid|expired|denied/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|[\x00-\x08\x0b-\x1f\x7f]/g;

export const timing = { urlMs: 30_000, codeMs: 30_000, maxMs: 10 * 60_000 };

type Live = { kind: LoginKind; onToken?: (token: string) => void; child: ChildProcess; info: LoginInfo; out: string; since: number; code?: string; timers: NodeJS.Timeout[]; onDone?: () => void };
const live = new Map<string, Live>();
const last = new Map<string, LoginInfo>();

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
// The terminal echoes the typed code; it is cut out before any pattern looks at the output.
const fresh = (l: Live) => (l.code ? l.out.slice(l.since).replaceAll(l.code, "") : l.out.slice(l.since));
const clean = (s: string) => s.replace(ANSI, "");

function finish(id: string, l: Live, state: LoginState, message: string | null): void {
  if (live.get(id) !== l) return;
  for (const t of l.timers) clearTimeout(t);
  l.code = undefined;
  l.out = "";
  l.info = { state, url: null, message, kind: l.kind };
  last.set(id, l.info);
  live.delete(id);
  l.child.kill("SIGKILL");
  l.onDone?.();
}

/** The login of one account: the running one, or the last one's outcome. */
export function loginInfo(id: string): LoginInfo | null {
  return live.get(id)?.info ?? last.get(id) ?? null;
}

export function loginRunning(id: string): boolean {
  return live.has(id);
}

/** Takes the token out of the CLI's output once it is complete; true when the flow has ended with it. */
function takeToken(id: string, l: Live, final: boolean): boolean {
  if (l.kind !== "token") return false;
  const t = extractToken(fresh(l), final);
  if (!t) return false;
  l.out = l.out.replaceAll(t, "");
  try {
    l.onToken?.(t);
  } catch {
    finish(id, l, "failed", "the token could not be saved");
    return true;
  }
  finish(id, l, "done", "token saved");
  return true;
}

/**
 * Starts a login (or, with kind "token", a long-lived token request) or returns the one running, and resolves
 * once its URL is known or it failed. `onDone` runs when it ends, however it ends; `onToken` gets the token.
 */
export async function startLogin(id: string, configDir: string, onDone?: () => void, kind: LoginKind = "login", onToken?: (token: string) => void): Promise<LoginInfo> {
  const running = live.get(id);
  if (running) return running.info;
  // A wide terminal keeps the URL on one line. exec: killing the pty's shell kills the CLI.
  const cmd = `stty cols 1000 rows 50 2>/dev/null; exec ${shq(claudeBin())} ${kind === "token" ? "setup-token" : "auth login --claudeai"}`;
  const child = spawn("script", ["-q", "-f", "-e", "-c", cmd, "/dev/null"], { env: childEnv(configDir, { BROWSER: "true" }), stdio: ["pipe", "pipe", "ignore"] });
  const l: Live = { kind, onToken, child, info: { state: "starting", url: null, message: null, kind }, out: "", since: 0, timers: [], onDone };
  live.set(id, l);
  last.delete(id);
  l.timers.push(setTimeout(() => finish(id, l, "failed", "the sign-in timed out"), timing.maxMs));
  child.stdin!.on("error", () => {});
  child.stdout!.on("data", (b: Buffer) => {
    l.out = (l.out + clean(b.toString("utf8"))).slice(-20_000);
    if (l.info.state === "starting") {
      const m = l.out.match(LOGIN_URL);
      if (m) l.info = { state: "waiting", url: m[0].replace(/[.,;:!?)\]]+$/, ""), message: null, kind };
    } else if (l.info.state === "checking") {
      if (takeToken(id, l, false)) return;
      const f = fresh(l);
      if (kind === "token") {
        if (LOGIN_FAILED.test(f)) finish(id, l, "failed", "the code was not accepted");
      } else if (LOGIN_OK.test(f)) finish(id, l, "done", "signed in");
      else if (LOGIN_FAILED.test(f)) finish(id, l, "failed", "the code was not accepted");
    }
  });
  child.on("error", () => finish(id, l, "failed", "the claude command could not be started"));
  child.on("close", (code) => {
    if (live.get(id) !== l) return;
    if (l.info.state === "checking" && takeToken(id, l, true)) return;
    if (l.info.state === "checking" && kind === "login" && (code === 0 || LOGIN_OK.test(fresh(l)))) finish(id, l, "done", "signed in");
    else finish(id, l, "failed", l.info.state === "checking" ? "the code was not accepted" : "the sign-in ended without a result");
  });
  const until = Date.now() + timing.urlMs;
  while (live.get(id) === l && l.info.state === "starting" && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  if (live.get(id) === l && l.info.state === "starting") finish(id, l, "failed", "the login command printed no sign-in URL");
  return loginInfo(id)!;
}

/** Sends the pasted code to the waiting login. Returns false when no login waits for one. */
export function submitCode(id: string, code: string): boolean {
  const l = live.get(id);
  if (!l || l.info.state !== "waiting" || !LOGIN_CODE.test(code)) return false;
  l.since = l.out.length;
  l.code = code;
  l.info = { state: "checking", url: null, message: null, kind: l.kind };
  l.timers.push(setTimeout(() => finish(id, l, "failed", "no answer to the code"), timing.codeMs));
  l.child.stdin!.write(`${code}\r`);
  return true;
}

export function cancelLogin(id: string): boolean {
  const l = live.get(id);
  if (!l) return false;
  finish(id, l, "cancelled", null);
  return true;
}
