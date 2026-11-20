import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useApi, useQuery } from "../../api/client";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Switch } from "../../ui/atoms/Switch";
import { Block } from "../../ui/molecules/Block";
import { CheckRow } from "../../ui/molecules/CheckRow";
import { useWrite } from "../../lib/hooks";
import { SectionTitle } from "./SectionTitle";

export function MySettings() {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("my-settings", (a) => a.me.settings.get());
  const [vals, setVals] = useState<{ fiveHour: string; weekly: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [maxCalls, setMaxCalls] = useState("");
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (!data) return;
    setManual(data.manualOnly);
    setVals({ fiveHour: String(data.reserve.fiveHour), weekly: String(data.reserve.weekly) });
    setPicks(data.repos);
    setMaxCalls(data.maxCalls === null ? "" : String(data.maxCalls));
  }, [data]);
  if (!data || !vals) return error ? <ErrorLine error={error.message} className="mt-4" /> : null;
  const savePicks = (next: string[]) => {
    const was = picks;
    setPicks(next);
    void write.run("repos", async () => {
      try {
        setPicks((await api.me.settings.put({ repos: next })).repos);
      } catch (e) {
        setPicks(was);
        throw e;
      }
    });
  };
  const choices = new Set(data.repoChoices);
  // Picks that are no longer available (pipeline off, or no write permission) stay listed so they can be removed.
  const shown = [...new Set([...data.repoChoices, ...picks])].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
  const valid = (v: string) => /^\d+$/.test(v) && Number(v) <= 90;
  const save = (next: { fiveHour: string; weekly: string }) => {
    if (!valid(next.fiveHour) || !valid(next.weekly)) {
      setProblem("Enter a whole number from 0 to 90.");
      return;
    }
    setProblem(null);
    const body = { reserve: { fiveHour: Number(next.fiveHour), weekly: Number(next.weekly) } };
    if (body.reserve.fiveHour === data.reserve.fiveHour && body.reserve.weekly === data.reserve.weekly) return;
    void write.run("settings", () => api.me.settings.put(body));
  };
  const validMax = (v: string) => v.trim() === "" || (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 64);
  const saveMax = (v: string) => {
    if (!validMax(v)) {
      setProblem("Enter a whole number from 1 to 64, or leave it empty for no limit.");
      return;
    }
    setProblem(null);
    const next = v.trim() === "" ? null : Number(v);
    if (next === data.maxCalls) return;
    void write.run("max-calls", () => api.me.settings.put({ maxCalls: next }));
  };
  const saveManual = (on: boolean) => {
    setManual(on);
    void write.run("manual-only", async () => {
      try {
        setManual((await api.me.settings.put({ manualOnly: on })).manualOnly);
      } catch (e) {
        setManual(!on);
        throw e;
      }
    });
  };
  const field = (key: "fiveHour" | "weekly", label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-44 shrink-0 text-ink/80">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={90}
        step={1}
        value={vals[key]}
        invalid={!valid(vals[key])}
        onChange={(e) => {
          const next = { ...vals, [key]: e.target.value };
          setVals(next);
        }}
        onBlur={() => save(vals)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save(vals);
        }}
        aria-label={label}
        className="w-20"
      />
      <span className="text-ink/55">%</span>
    </label>
  );
  return (
    <Block className="mt-4" title={<SectionTitle icon={SlidersHorizontalIcon}>My settings</SectionTitle>}>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-6">
        {field("fiveHour", "Keep free: 5-hour window")}
        {field("weekly", "Keep free: weekly")}
        <label className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 text-ink/80">Max calls at once</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={64}
            step={1}
            placeholder="None"
            value={maxCalls}
            invalid={!validMax(maxCalls)}
            onChange={(e) => setMaxCalls(e.target.value)}
            onBlur={() => saveMax(maxCalls)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveMax(maxCalls);
            }}
            aria-label="Max calls at once"
            className="w-20"
          />
        </label>
        <span className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 text-ink/80">Manual only</span>
          <Switch on={manual} onChange={saveManual} label="Manual only" busy={write.busy === "manual-only"} />
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:gap-2">
        <span className="w-44 shrink-0 pt-1.5 text-sm text-ink/80">My repos</span>
        <div role="group" aria-label="My repos" className="min-w-0 flex-1 rounded-md border border-line sm:max-w-sm">
          <CheckRow checked={!picks.length} onChange={() => picks.length && savePicks([])} title="All repos" />
          {shown.map((r) => {
            const on = picks.includes(r);
            const ok = choices.has(r);
            return (
              <CheckRow
                key={r}
                checked={on}
                onChange={() => savePicks(on ? picks.filter((x) => x !== r) : [...picks, r].sort())}
                title={
                  <span className={ok ? undefined : "line-through opacity-60"} title={ok ? undefined : "Pipeline off or no write permission"}>
                    {r}
                  </span>
                }
              />
            );
          })}
        </div>
      </div>
      <ErrorLine error={problem ?? write.error} className="mt-2" />
    </Block>
  );
}
