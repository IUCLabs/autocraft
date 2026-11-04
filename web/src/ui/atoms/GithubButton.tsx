import { GithubLogoIcon } from "@phosphor-icons/react";
import { cn } from "../cn";

/**
 * The GitHub logo as a small link to `href` in a new tab. The visible icon is small; an invisible hit area around it
 * reaches 32 px on desktop and 44 px on touch screens without changing the row's height. It sets `relative z-10`,
 * so it stays clickable inside a stretched row.
 */
export function GithubButton({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title="Open on GitHub"
      className={cn(
        "relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded text-ink/55 hover:text-ink",
        "after:absolute after:left-1/2 after:top-1/2 after:size-8 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded [@media(pointer:coarse)]:after:size-11",
        "hover:after:bg-ink/10",
        className,
      )}
    >
      <GithubLogoIcon aria-hidden size="1.1em" weight="bold" />
    </a>
  );
}
