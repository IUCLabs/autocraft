import { cn } from "./cn";

/** `repo#123`, linking to the GitHub issue or PR in a new tab. GitHub redirects /issues/N to the PR when N is one. */
export function RefLink({ repo, number, kind, children, className, stop }: { repo: string; number: number; kind?: "pr" | "issue"; children?: React.ReactNode; className?: string; stop?: boolean }) {
  return (
    <a
      href={`https://github.com/storytold/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`}
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
