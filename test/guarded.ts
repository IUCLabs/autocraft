// A Guarded value without running the guard, for tests of the write functions themselves.
import type { Guarded, GuardedRepo } from "../src/core/guard.ts";
import type { Want } from "../src/core/gates.ts";

export const guarded = (repo: string, number: number, head: string, action: Want = { kind: "merge" }): Guarded => ({ repo, number, head, action }) as unknown as Guarded;

/** A repo-level grant without running the guard. */
export const G = (repo: string): GuardedRepo => ({ scope: "repo", need: null, repo }) as unknown as GuardedRepo;
