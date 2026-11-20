import { useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { cn } from "../cn";
import { Button } from "../atoms/Button";
import { num } from "../../lib/format";

/**
 * Monospace text with a copy button; text longer than `lines` lines is clipped with a "Show all" toggle.
 * `compact` drops the title row and shows the whole text with a copy icon in its corner, for short commands: one line wraps,
 * several lines keep their layout and scroll sideways.
 */
export function CodeBlock({ title, text, lines = 12, className, compact }: { title?: string; text: string; lines?: number; className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
  if (compact)
    return (
      <div className={cn("relative min-w-0", className)}>
        <pre className={cn("code overflow-auto rounded border border-line bg-sunken py-1.5 pl-2.5 pr-9 text-xs leading-relaxed", text.includes("\n") ? "whitespace-pre" : "whitespace-pre-wrap break-words")}>{text}</pre>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : `Copy ${title ?? "text"}`}
          title={copied ? "Copied" : "Copy"}
          className={cn(
            "absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded text-ink/55 hover:bg-ink/[0.07] hover:text-ink",
            "after:absolute after:left-1/2 after:top-1/2 after:size-7 after:-translate-x-1/2 after:-translate-y-1/2 [@media(pointer:coarse)]:after:size-11",
            copied && "text-ok hover:text-ok",
          )}
        >
          {copied ? <CheckIcon aria-hidden weight="bold" /> : <CopyIcon aria-hidden />}
        </button>
      </div>
    );
  const long = text.split("\n").length > lines || text.length > lines * 120;
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex min-h-7 items-center gap-2 text-xs text-ink/60">
        {title && <span className="font-semibold">{title}</span>}
        <span className="num text-ink/45">{num(text.length)} characters</span>
        <Button size="sm" variant="ghost" icon={copied ? CheckIcon : CopyIcon} onClick={copy} className="ml-auto" aria-label={`Copy ${title ?? "text"}`}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        className="code overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-sunken p-3 text-xs leading-relaxed"
        style={long && !open ? { maxHeight: `${lines * 1.4}rem` } : { maxHeight: "70vh" }}
      >
        {text}
      </pre>
      {long && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-xs font-medium text-accent-ink hover:underline max-md:min-h-11">
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
