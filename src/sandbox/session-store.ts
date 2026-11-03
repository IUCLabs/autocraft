// The host directory that holds the session store of one sandboxed call.
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkoutRoot } from "./checkout.ts";

/**
 * The host directory that holds the session store of one sandboxed call, bound over the sandbox's
 * `projects` directory (the sandbox's own config directory is a tmpfs, gone when the call ends).
 * One directory per call under the checkout root's parent (the app's cache), never shared; the caller removes it.
 */
export function sessionStore(): string {
  const root = join(dirname(checkoutRoot()), "sessions");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "call-"));
}
