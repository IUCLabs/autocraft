import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitPullRequestIcon, CircleDotIcon, SearchIcon } from "lucide-react";
import { useApi } from "../api/client";
import type { SearchHit } from "../api/types";
import { Kbd } from "../ui/Kbd";
import { cn } from "../ui/cn";

/** Global search: `repo#123`, `#123`, a title fragment or an author login. */
export function SearchBox({ autoFocus, onPick, fullscreen }: { autoFocus?: boolean; onPick?: () => void; fullscreen?: boolean }) {
  const api = useApi();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => api.search(q).then((h) => live && (setHits(h), setSel(0))), 90);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, api]);

  const pick = (h: SearchHit) => {
    navigate(`/item/${h.repo}/${h.number}`);
    setQ("");
    onPick?.();
    (document.activeElement as HTMLElement | null)?.blur();
  };
  const open = (focus || fullscreen) && q.length > 0;

  return (
    <div className={cn("relative", fullscreen && "flex-1")}>
      <label className={cn("flex h-7 items-center gap-2 rounded border border-line bg-sunken px-2 focus-within:border-accent/60", fullscreen && "h-11")}>
        <SearchIcon className="text-xs text-ink/45" />
        <input
          id={fullscreen ? undefined : "global-search"}
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, hits.length - 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
            if (e.key === "Enter" && hits[sel]) pick(hits[sel]);
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
          placeholder="photocraft#4127, title or author"
          aria-label="Search issues and PRs"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink/35"
          role="combobox"
          aria-expanded={open}
          aria-controls="search-results"
        />
        {!fullscreen && !focus && <Kbd keys="/" />}
      </label>
      {open && (
        <ul id="search-results" role="listbox" className={cn("z-50 rounded-md border border-line-strong bg-raised p-1 animate-fadeIn", fullscreen ? "mt-2" : "absolute inset-x-0 top-[calc(100%+4px)] shadow-[0_12px_32px_rgba(0,0,0,0.28)]")}>
          {hits.length === 0 && <li className="px-3 py-2 text-sm text-ink/50">No matches</li>}
          {hits.map((h, i) => (
            <li key={`${h.repo}#${h.number}`} role="option" aria-selected={i === sel}>
              <button onMouseDown={() => pick(h)} onMouseEnter={() => setSel(i)} className={cn("flex w-full items-center gap-2.5 rounded px-2 text-left", fullscreen ? "h-12" : "h-8", i === sel && "bg-ink/[0.07]")}>
                {h.kind === "pr" ? <GitPullRequestIcon className={cn("text-xs", h.state === "merged" ? "text-merged" : "text-ok")} /> : <CircleDotIcon className="text-xs text-ok" />}
                <span className="code shrink-0 text-ink/60">
                  {h.repo}#{h.number}
                </span>
                <span className="truncate text-sm">{h.title}</span>
                <span className="ml-auto shrink-0 text-xs text-ink/45">{h.author}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
