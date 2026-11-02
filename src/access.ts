// The dashboard's access list. The Access page and the CLI both write through
// these functions, so every change ends the login's sessions and is audited.
import type { DatabaseSync } from "node:sqlite";
import { connect } from "./db.ts";
import { audit } from "./dash/audit.ts";
import type { Role } from "./dash/types.ts";

export type AccessRow = { login: string; role: Role; added_by: string | null; added_at: string | null; note: string | null };

export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const ROLES: readonly Role[] = ["operator", "maintainer", "viewer"];
export const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v);

export class AccessError extends Error {}

export function listAccess(db: DatabaseSync): AccessRow[] {
  return db.prepare("SELECT login, role, added_by, added_at, note FROM access ORDER BY role, login COLLATE NOCASE").all() as AccessRow[];
}

export function getAccess(db: DatabaseSync, login: string): AccessRow | undefined {
  return db.prepare("SELECT login, role, added_by, added_at, note FROM access WHERE login = ?").get(login) as AccessRow | undefined;
}

function endSessions(db: DatabaseSync, login: string): number {
  db.prepare("DELETE FROM repo_permissions WHERE login = ?").run(login);
  return Number(db.prepare("DELETE FROM sessions WHERE login = ?").run(login).changes);
}

function tx<T>(db: DatabaseSync, f: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = f();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function addLogin(db: DatabaseSync, by: string, login: string, role: Role, note: string | null): void {
  if (!LOGIN.test(login)) throw new AccessError(`not a GitHub login: ${JSON.stringify(login)}`);
  if (!isRole(role)) throw new AccessError(`role must be ${ROLES.join(", ")}`);
  tx(db, () => {
    if (getAccess(db, login)) throw new AccessError(`${login} is already on the access list`);
    db.prepare("INSERT INTO access (login, role, added_by, added_at, note) VALUES (?, ?, ?, ?, ?)")
      .run(login, role, by, new Date().toISOString(), note || null);
    audit(db, by, "access-add", login, { role });
  });
}

export function removeLogin(db: DatabaseSync, by: string, login: string): void {
  tx(db, () => {
    const row = getAccess(db, login);
    if (!row) throw new AccessError(`${login} is not on the access list`);
    db.prepare("DELETE FROM access WHERE login = ?").run(login);
    const sessions = endSessions(db, login);
    audit(db, by, "access-remove", row.login, { role: row.role, sessions });
  });
}

export function setRole(db: DatabaseSync, by: string, login: string, role: Role): void {
  if (!isRole(role)) throw new AccessError(`role must be ${ROLES.join(", ")}`);
  tx(db, () => {
    const row = getAccess(db, login);
    if (!row) throw new AccessError(`${login} is not on the access list`);
    if (row.role === role) return;
    db.prepare("UPDATE access SET role = ? WHERE login = ?").run(role, login);
    const sessions = endSessions(db, login);
    audit(db, by, "access-role", row.login, { from: row.role, to: role, sessions });
  });
}

export function operatorCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM access WHERE role = 'operator'").get() as { n: number }).n);
}

const USAGE = "usage: craft-auto access list | add <login> [--operator|--maintainer] [--note TEXT] | remove <login> | role <login> operator|maintainer|viewer";

function run(args: string[]): void {
  const [sub, login, ...rest] = args;
  const db = connect();
  try {
    switch (sub) {
      case "list": {
        const rows = listAccess(db);
        if (!rows.length) console.log("access list is empty");
        for (const r of rows) {
          console.log(`${r.login.padEnd(40)} ${r.role.padEnd(10)} added ${r.added_at?.slice(0, 10) ?? "-"} by ${r.added_by ?? "-"}${r.note ? `  ${r.note}` : ""}`);
        }
        return;
      }
      case "add": {
        if (!login) break;
        let role: Role = "viewer";
        let note: string | null = null;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--operator") role = "operator";
          else if (rest[i] === "--maintainer") role = "maintainer";
          else if (rest[i] === "--note" && i + 1 < rest.length) note = rest[++i]!;
          else throw new AccessError(`unknown argument ${rest[i]}\n${USAGE}`);
        }
        addLogin(db, "cli", login, role, note);
        console.log(`added ${login} as ${role}`);
        return;
      }
      case "remove":
        if (!login) break;
        removeLogin(db, "cli", login);
        console.log(`removed ${login}; their sessions are ended`);
        return;
      case "role": {
        const role = rest[0];
        if (!login || !isRole(role)) break;
        setRole(db, "cli", login, role);
        console.log(`${login} is ${role}; their sessions are ended`);
        return;
      }
    }
    throw new AccessError(USAGE);
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

export const commands = {
  access: { summary: "dashboard access list: list | add <login> [--operator|--maintainer] [--note] | remove <login> | role <login> operator|maintainer|viewer", run },
};
