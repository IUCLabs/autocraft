import { githubItemUrl } from "../lib/links";
import type { ItemKind } from "../api/types";
import { cn } from "./cn";

/** Deprecated: use ItemRef or ItemIcon. `repo#123`, linking to the GitHub issue or PR in a new tab. GitHub redirects /issues/N to the PR when N is one. */
export function RefLink({ repo, number, kind, children, className, stop }: { repo: string; number: number; kind?: ItemKind; children?: React.ReactNode; className?: string; stop?: boolean }) {
  return (
    <a
      href={githubItemUrl(repo, number, kind)}
      target="_blank"
      rel="noopener noreferrer"
      title="Open on GitHub"
      className={cn("code text-accent-ink hover:underline", className)}
      onClick={stop ? (e) => e.stopPropagation() : undefined}
      onMouseDown={stop ? (e) => e.stopPropagation() : undefined}
    >
      {children ?? `${repo}#${number}`}
    </a>
  );
}
