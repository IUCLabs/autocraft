// One step = one fresh, locked-down container. Nothing from the host
// environment is passed in: the only env vars are the ones set below.
import { execFile, spawn } from "node:child_process";
import type { WorkerConfig } from "./config.ts";

export const LABEL = "craft-worker";

export type StepMounts = {
  src: string; // read-only /src
  target: string; // writable /target, private to the task
  cache: string; // writable /cache (CARGO_HOME), private to the task
  out: string; // writable /out, artifacts of this step
};

export type RunSpec = {
  name: string;
  image: string;
  network: "fetch" | "none";
  mounts: StepMounts;
  cmd: string[];
};

const bind = (source: string, target: string, ro: boolean) => `type=bind,source=${source},target=${target}${ro ? ",readonly" : ""}`;

export function runArgs(cfg: WorkerConfig, s: RunSpec): string[] {
  const mem = `${Math.round(cfg.limits.memoryGb * 1024)}m`;
  return [
    "run",
    "--rm",
    "--name", s.name,
    "--label", `${LABEL}=1`,
    "--pull", "missing",
    "--network", s.network === "fetch" ? cfg.fetchNetwork : "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=2g",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "all",
    "--userns", cfg.userns,
    "--cpus", String(cfg.limits.cpus),
    "--memory", mem,
    "--memory-swap", mem,
    "--pids-limit", String(cfg.limits.pids),
    "--workdir", "/src",
    "--mount", bind(s.mounts.src, "/src", true),
    "--mount", bind(s.mounts.target, "/target", false),
    "--mount", bind(s.mounts.cache, "/cache", false),
    "--mount", bind(s.mounts.out, "/out", false),
    "--env", "HOME=/tmp",
    "--env", "CARGO_HOME=/cache/cargo",
    "--env", "CARGO_TARGET_DIR=/target",
    "--env", "CI=1",
    s.image,
    ...s.cmd,
  ];
}

function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 30_000 }, () => resolve()));
}

export async function removeContainer(cfg: WorkerConfig, name: string): Promise<void> {
  await exec(cfg.runtime, ["rm", "-f", name]);
}

/** Removes containers left by a previous worker process. */
export async function removeStaleContainers(cfg: WorkerConfig): Promise<void> {
  const ids = await new Promise<string[]>((resolve) =>
    execFile(cfg.runtime, ["ps", "-a", "-q", "--filter", `label=${LABEL}`], { timeout: 30_000 }, (err, out) => resolve(err ? [] : String(out).split("\n").filter((l) => /^[0-9a-zA-Z_.-]+$/.test(l)))),
  );
  for (const id of ids) await exec(cfg.runtime, ["rm", "-f", id]);
}

export type RunOutcome = { exitCode: number | null; timedOut: boolean; cancelled: boolean };

export async function runContainer(cfg: WorkerConfig, spec: RunSpec, o: { timeoutMs: number; signal: AbortSignal; onOutput: (b: Buffer) => void }): Promise<RunOutcome> {
  const child = spawn(cfg.runtime, runArgs(cfg, spec), { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", o.onOutput);
  child.stderr.on("data", o.onOutput);
  let timedOut = false;
  let cancelled = false;
  let hard: NodeJS.Timeout | undefined;
  const stop = () => {
    void exec(cfg.runtime, ["kill", spec.name]);
    hard ??= setTimeout(() => child.kill("SIGKILL"), 10_000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, o.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  if (o.signal.aborted) onAbort();
  else o.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (c) => resolve(c));
    });
    return { exitCode: timedOut || cancelled ? null : code, timedOut, cancelled };
  } finally {
    clearTimeout(timer);
    if (hard) clearTimeout(hard);
    o.signal.removeEventListener("abort", onAbort);
    await removeContainer(cfg, spec.name);
  }
}
