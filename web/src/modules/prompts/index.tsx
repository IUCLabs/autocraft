import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, ScrollTextIcon } from "lucide-react";
import { useQuery } from "../../api/client";
import type { PromptInfo } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={done ? CheckIcon : CopyIcon}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? "Copied" : label}
    </Button>
  );
}

/** Monospace, wrapped, with `{{name}}` placeholders marked when `marks` is set. */
function Code({ text, title, marks, className }: { text: string; title: string; marks?: boolean; className?: string }) {
  const parts = marks ? text.split(/(\{\{\w+\}\})/) : [text];
  return (
    <div className={cn("min-w-0 overflow-hidden rounded border border-line bg-sunken", className)}>
      <div className="flex h-8 items-center border-b border-line pl-3 pr-1 text-xs text-ink/55">
        <span>{title}</span>
        <span className="ml-auto">
          <CopyButton text={text} />
        </span>
      </div>
      <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
        {parts.map((p, i) =>
          i % 2 ? (
            <mark key={i} className="rounded-sm bg-accent/15 px-0.5 text-accent-ink">
              {p}
            </mark>
          ) : (
            p
          ),
        )}
      </pre>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-xs font-semibold text-ink/60">{label}</h3>
      {children}
    </div>
  );
}

export function PromptCard({ p }: { p: PromptInfo }) {
  const [example, setExample] = useState(false);
  return (
    <section id={p.id} className="min-w-0 scroll-mt-4 rounded-md border border-line px-4 pb-4 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm font-semibold">{p.id}</h2>
        {p.models.map((m) => (
          <Badge key={m} tone="accent">
            {m}
          </Badge>
        ))}
      </div>
      <p className="mt-1 text-sm text-ink/75">{p.purpose}</p>

      <Field label="Call">
        <Code text={p.command} title={p.runner === "jev" ? "Command (request on stdin)" : "Command (prompt on stdin)"} />
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {p.settings.map((s) => (
            <div key={s.label} className="contents">
              <dt className="text-ink/55">{s.label}</dt>
              <dd className="min-w-0">{s.value}</dd>
            </div>
          ))}
        </dl>
      </Field>

      <Field label={p.runner === "jev" ? "Request template" : "Prompt template"}>
        <Code text={p.template} title={p.runner === "jev" ? "JSON, sent as one line" : "Text"} marks />
        <ul className="mt-2 space-y-1 text-sm">
          {p.placeholders.map((ph) => (
            <li key={ph.name}>
              <code className="rounded-sm bg-accent/15 px-1 font-mono text-xs text-accent-ink">{`{{${ph.name}}}`}</code> {ph.meaning}
            </li>
          ))}
        </ul>
      </Field>

      {p.questions.length > 0 && (
        <Field label="Questions">
          <div className="overflow-x-auto rounded border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink/55">
                  <th className="px-3 py-1.5 font-medium">Question</th>
                  <th className="px-3 py-1.5 font-medium">Type</th>
                  <th className="px-3 py-1.5 font-medium">Instructions and criteria</th>
                </tr>
              </thead>
              <tbody>
                {p.questions.map((q) => (
                  <tr key={q.id} className="border-t border-line align-top">
                    <td className="px-3 py-1.5 font-mono text-xs">{q.id}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{q.type}</td>
                    <td className="min-w-[16rem] px-3 py-1.5">
                      {q.instructions}
                      {q.criteria && (
                        <ul className="mt-1 list-disc pl-5 text-ink/75">
                          {Object.entries(q.criteria).map(([k, v]) => (
                            <li key={k}>
                              <span className="font-medium text-ink">{k}</span>: {v}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Field>
      )}

      <Field label="Expected output">
        <p className="font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{p.output}</p>
      </Field>
      <Field label="How the output is checked">
        <p className="text-sm">{p.validation}</p>
      </Field>

      <button
        type="button"
        onClick={() => setExample((v) => !v)}
        aria-expanded={example}
        className="mt-4 flex items-center gap-1 text-sm font-medium text-accent-ink hover:underline"
      >
        <ChevronRightIcon className={cn("transition-transform", example && "rotate-90")} />
        Rendered example
      </button>
      {example && (
        <Code
          className="mt-2"
          text={p.example}
          title={`Exactly as sent, for made-up item${p.exampleItems.length > 1 ? "s" : ""} ${p.exampleItems.join(", ")}`}
        />
      )}
    </section>
  );
}

function Prompts(_: ViewProps) {
  const { data: r, error } = useQuery("prompts", (api) => api.prompts());
  if (error && !r) return <div className="p-6 text-bad">{error.message}</div>;
  if (!r) return <div className="p-6 text-ink/50">Loading…</div>;
  const stages = [...new Set(r.prompts.map((p) => p.stage))];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 pb-12 pt-5 md:px-6">
        <h1 className="text-xl font-semibold">Prompts</h1>
        <p className="mt-1 text-sm text-ink/70">
          Every prompt the pipeline sends to a model, as it is sent. The pipeline builds each call from these entries.{" "}
          <span className="text-ink/55">
            Server commit:{" "}
            {r.commit ? (
              <code className="font-mono text-xs" title={r.commit}>
                {r.commit.slice(0, 12)}
              </code>
            ) : (
              "unknown"
            )}
          </span>
        </p>
        <p className="mt-3 rounded border border-line bg-raised/40 px-3 py-2 text-sm">
          Item text is quoted into prompts as untrusted data, and models are told never to follow it. Dashboard comments and opinions never enter a prompt.
        </p>
        <nav className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {r.prompts.map((p) => (
            <a key={p.id} href={`#${p.id}`} className="font-mono text-xs text-accent-ink hover:underline">
              {p.id}
            </a>
          ))}
        </nav>
        {stages.map((s) => (
          <div key={s} className="mt-6">
            <h2 className="mb-2 text-xs font-semibold text-ink/60">{s}</h2>
            <div className="space-y-4">
              {r.prompts
                .filter((p) => p.stage === s)
                .map((p) => (
                  <PromptCard key={p.id} p={p} />
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export const promptsModule: FeatureModule = {
  id: "prompts",
  permission: "viewer",
  nav: { label: "Prompts", icon: ScrollTextIcon, to: "/prompts", group: "insight", order: 21 },
  commands: [],
  routes: [{ path: "prompts", view: { id: "prompts", title: "Prompts", panels: [{ id: "main", title: "Prompts", component: Prompts, defaultSize: 100 }] } }],
};
