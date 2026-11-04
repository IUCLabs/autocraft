import type { TraceKind } from "../../api/types";
import { Chip } from "../atoms/Chip";
import { TRACE_KIND, TRACE_KINDS } from "../../lib/trace";

/** Kind chips (none active means every kind) and the "Only AutoCraft" switch. */
export function TraceFilters({ kinds, onKinds, autocraftOnly, onAutocraftOnly }: {
  kinds: TraceKind[];
  onKinds: (k: TraceKind[]) => void;
  autocraftOnly: boolean;
  onAutocraftOnly: (v: boolean) => void;
}) {
  const toggle = (k: TraceKind) => onKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {TRACE_KINDS.map((k) => (
        <Chip key={k} active={kinds.includes(k)} onClick={() => toggle(k)}>
          {TRACE_KIND[k].label}
        </Chip>
      ))}
      <Chip active={autocraftOnly} onClick={() => onAutocraftOnly(!autocraftOnly)} className="ml-auto max-md:ml-0">
        Only AutoCraft
      </Chip>
    </div>
  );
}
