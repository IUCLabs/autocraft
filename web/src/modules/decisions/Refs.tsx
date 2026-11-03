import { Fragment } from "react";
import { Link } from "react-router-dom";
import { RefLink } from "../../ui/RefLink";

// A "#123" not preceded by a word character or slash; "repo#123" and URLs are left alone.
const REF = /(?<![\w/])#(\d+)\b/g;

/** Text in which every `#number` links to the item page, with the GitHub link beside it. Plain text when the repo is unknown. */
export function Refs({ text, repo }: { text: string; repo: string | null }) {
  if (!repo) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    const n = Number(m[1]);
    out.push(text.slice(last, m.index));
    out.push(
      <Fragment key={m.index}>
        <Link to={`/item/${repo}/${n}`} className="code text-accent-ink hover:underline">
          #{n}
        </Link>
        <RefLink repo={repo} number={n} className="ml-0.5 text-ink/40" stop>
          ↗
        </RefLink>
      </Fragment>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}
