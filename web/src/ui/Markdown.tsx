import { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon, ExternalLinkIcon } from "lucide-react";
import { cn } from "./cn";

// GitHub-flavoured Markdown from issue and PR bodies. Untrusted input:
// raw HTML is dropped (skipHtml), links open in a new tab without referrer,
// and images never load inline (the CSP allows only same-origin images);
// they become a link the reader can choose to open.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="md-image" title={src}>
      <ImageIcon className="text-[13px]" />
      <span>{alt || "Image"}</span>
      <ExternalLinkIcon className="text-[11px] opacity-60" />
    </a>
  ),
};

const safeUrl = (url: string) => (/^(https?:|mailto:|#|\/)/i.test(url) ? url : "");

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn("md", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components} urlTransform={safeUrl}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** Clamps long content to about `lines` lines of text with a "Show all" toggle. */
export function Collapsible({ lines, children }: { lines: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [open, setOpen] = useState(false);
  const max = lines * 20;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflow(el.scrollHeight > max + 40);
  }, [max, children]);
  return (
    <div>
      <div ref={ref} className={cn("relative", overflow && !open && "overflow-hidden")} style={overflow && !open ? { maxHeight: max } : undefined}>
        {children}
        {overflow && !open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-panel to-transparent" />}
      </div>
      {overflow && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-xs font-medium text-accent-ink hover:underline">
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
