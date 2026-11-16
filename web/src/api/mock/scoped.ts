// The mockup's stand-in for the server's project scope: drops every listed row that names another repo.
// Counts are left as they are; it is good enough to see the app narrowed to one project.
import type { Api } from "../client";
import { getScope } from "../scope";

const UNSCOPED = new Set(["repos", "repoOwners", "me"]);

function narrow(v: unknown, repo: string, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    return v
      .filter((x) => !(x && typeof x === "object" && "repo" in x && typeof (x as { repo: unknown }).repo === "string" && (x as { repo: string }).repo !== repo))
      .map((x) => narrow(x, repo, depth + 1));
  }
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, narrow(x, repo, depth + 1)]));
}

function wrap<T extends object>(target: T, path: string): T {
  return new Proxy(target, {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv) as unknown;
      if (typeof key !== "string" || (path === "" && UNSCOPED.has(key))) return v;
      if (typeof v === "function")
        return (...args: unknown[]) => {
          const out = (v as (...a: unknown[]) => unknown).apply(t, args);
          const repo = getScope();
          return repo && out instanceof Promise ? out.then((x) => narrow(x, repo)) : out;
        };
      if (v && typeof v === "object" && !Array.isArray(v)) return wrap(v, `${path}.${key}`);
      return v;
    },
  });
}

export const scopedMockApi = (api: Api): Api => wrap(api, "");
