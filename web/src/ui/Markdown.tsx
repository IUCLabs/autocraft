import { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon, ExternalLinkIcon } from "lucide-react";
import { cn } from "./cn";

// Images the server's proxy (GET /img, src/dash/server/images.ts) fetches:
// the same hosts and path shapes. Anything else stays a link.
const PROXIED: [string, RegExp][] = [
  ["github.com", /^\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["private-user-images.githubusercontent.com", /^\/./],
  ["user-images.githubusercontent.com", /^\/./],
  ["raw.githubusercontent.com", /^\/storytold\/./],
  ["avatars.githubusercontent.com", /^\/./],
];

export function proxiedImage(src: string): string | null {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (!PROXIED.some(([host, path]) => u.hostname === host && path.test(u.pathname))) return null;
  return `/img?${new URLSearchParams({ u: u.href })}`;
}

function ImageLink({ src, alt }: { src?: string; alt?: string }) {
  return (
    <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="md-image" title={src}>
      <ImageIcon className="text-[13px]" />
      <span>{alt || "Image"}</span>
      <ExternalLinkIcon className="text-[11px] opacity-60" />
    </a>
  );
}

// A GitHub-hosted image, shown inline through the proxy; a click opens the
// original in a new tab. If the proxy refuses it, it falls back to the link.
function Image({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const proxied = src ? proxiedImage(src) : null;
  if (!proxied || failed) return <ImageLink src={src} alt={alt} />;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="md-inline-image" title={alt || undefined}>
      <img src={proxied} alt={alt ?? ""} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </a>
  );
}

// GitHub-flavoured Markdown from issue and PR bodies. Untrusted input:
// raw HTML is dropped (skipHtml), links open in a new tab without referrer,
// and only GitHub-hosted images load inline, through the same-origin proxy
// (the CSP allows only same-origin images); others become a link the reader
// can choose to open.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) => <Image src={typeof src === "string" ? src : undefined} alt={alt} />,
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
    if (!el) return;
    const measure = () => setOverflow(el.scrollHeight > max + 40);
    measure();
    // Inline images load after the first layout and can make the content taller.
    const inner = el.firstElementChild;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
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
