import type { Decision, DuplicateMember } from "../../api/types";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Card } from "../../ui/atoms/Card";
import { ItemRef } from "../../ui/molecules/ItemRef";

const ROLE: Record<DuplicateMember["role"], { label: string; tone: Tone }> = {
  keep: { label: "Keep", tone: "ok" },
  close: { label: "Close", tone: "bad" },
  stay: { label: "Stays open", tone: "neutral" },
};

/** What the page knows about a member's item: its title and state come from the decision's items or related list. */
function shownOf(d: Decision, m: DuplicateMember) {
  const it = d.items.find((i) => i.number === m.number);
  if (it) return { kind: it.kind ?? m.kind, state: it.state, title: it.title };
  const rel = d.related.find((r) => r.number === m.number);
  if (rel) return { kind: rel.kind, state: rel.state, title: rel.title };
  if (d.number === m.number && d.shown) return { kind: d.shown.kind ?? m.kind, state: d.shown.state, title: d.shown.title };
  return { kind: m.kind, state: null, title: null };
}

function Points({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <h3 className="text-xs font-semibold text-ink/60">{title}</h3>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-sm leading-[21px] text-ink/85 marker:text-ink/30">
        {items.map((t, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The members of a duplicate group, kept one first, each with its role and its own points. */
export function DuplicateGroup({ d }: { d: Decision }) {
  const order = { keep: 0, stay: 1, close: 2 };
  const members = [...d.group].sort((a, b) => order[a.role] - order[b.role]);
  return (
    <ul className="mt-3 grid gap-2">
      {members.map((m) => {
        const shown = shownOf(d, m);
        const role = ROLE[m.role];
        return (
          <Card as="li" key={m.number} padding="sm">
            <div className="flex items-start gap-2">
              <ItemRef repo={d.repo} number={m.number} kind={shown.kind} state={shown.state} title={shown.title} className="flex-1" />
              <Badge tone={role.tone}>{role.label}</Badge>
            </div>
            <Points title="Does better" items={m.better} />
            <Points title="Worth carrying over" items={m.carry} />
            <Points title="Adds" items={m.adds} />
          </Card>
        );
      })}
    </ul>
  );
}

export function RiskList({ risks }: { risks: string[] }) {
  return (
    <section className="mt-3">
      <h2 className="text-xs font-semibold text-ink/60">Risks</h2>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm leading-[21px] text-ink/85 marker:text-ink/30">
        {risks.map((r, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">
            {r}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Recommended: <option> — <reason>", only when the model gave a reason. */
export function RecommendationLine({ d }: { d: Decision }) {
  const label = d.options.find((o) => o.key === d.recommended)?.label;
  if (!label || !d.recommendedReason) return null;
  return (
    <p className="text-sm leading-[21px] text-ink/85">
      <span className="font-medium">Recommended: {label}</span> — {d.recommendedReason}
    </p>
  );
}
