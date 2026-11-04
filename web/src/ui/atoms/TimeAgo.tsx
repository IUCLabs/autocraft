import { ago, whenZ } from "../../lib/format";
import { useNow } from "../../lib/useNow";

/** "3m" or "3 minutes ago"; re-renders as time passes. The tooltip shows the time in the viewer's time zone. */
export function TimeAgo({ iso, short = true, className }: { iso: string; short?: boolean; className?: string }) {
  useNow();
  return (
    <time dateTime={iso} title={whenZ(iso)} className={className}>
      {short ? ago(iso) : ago(iso, false)}
    </time>
  );
}
