// Reads the org setup link needs, made with the visiting org owner's own token:
// whether they own the organization, and the id of its "app manager" role. The
// token comes in as an argument, is used for these calls and is never kept here.
import { AppError, call, GITHUB_API, type AppDeps } from "./app.ts";

export type OrgRole = { id: number; name: string };

/** True when the token's user is an active owner (admin) of the org. */
export async function isOrgOwner(token: string, org: string, deps: AppDeps = {}): Promise<boolean> {
  try {
    const m = (await call(deps.apiBase ?? GITHUB_API, `/user/memberships/orgs/${encodeURIComponent(org)}`, token)) as { role?: unknown; state?: unknown } | null;
    return m?.role === "admin" && m.state === "active";
  } catch (e) {
    if (e instanceof AppError && (e.status === 403 || e.status === 404)) return false;
    throw e;
  }
}

/** The org's predefined app manager role, or null when the org has none (plans without organization roles answer 404). */
export async function appManagerRole(token: string, org: string, deps: AppDeps = {}): Promise<OrgRole | null> {
  try {
    const r = (await call(deps.apiBase ?? GITHUB_API, `/orgs/${encodeURIComponent(org)}/organization-roles`, token)) as { roles?: Array<{ id?: unknown; name?: unknown }> } | null;
    for (const x of r?.roles ?? []) if (typeof x.id === "number" && typeof x.name === "string" && /app[ _-]?manager/i.test(x.name)) return { id: x.id, name: x.name };
    return null;
  } catch (e) {
    if (e instanceof AppError && e.status === 404) return null;
    throw e;
  }
}
