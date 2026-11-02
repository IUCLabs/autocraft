import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type {
  AccessOverview,
  AnswerInput,
  AuditFilter,
  AuditPage,
  Contributor,
  ContributorFilter,
  ContributorList,
  ClassifierReport,
  CostReport,
  Decision,
  DecisionComment,
  DecisionFilter,
  DecisionList,
  DisagreementFilter,
  DisagreementList,
  Item,
  ItemFilter,
  ItemList,
  OverrideInput,
  Progress,
  PromptsReport,
  RepoName,
  Role,
  RulePreview,
  SearchHit,
  TrackedRepo,
  User,
  WhitelistRule,
  Job,
  JobDetail,
  JobFilter,
  JobList,
  JobParams,
  PipelineOverview,
  Schedule,
  ScheduleInput,
} from "./types";

/** The dashboard API as the frontend sees it. The mock and the HTTP client both implement it. */
export interface Api {
  me(): Promise<User>;
  repos(): Promise<RepoName[]>;
  decisions: {
    list(filter: DecisionFilter): Promise<DecisionList>;
    get(id: string): Promise<Decision>;
    answer(id: string, input: AnswerInput): Promise<Decision>;
    undo(id: string): Promise<Decision>;
    /** Give or change the signed-in user's opinion (anyone signed in). */
    opine(id: string, input: { option: string | null; note?: string }): Promise<Decision>;
    retract(id: string): Promise<Decision>;
    /** Operator only: answer with the opinion's option. */
    adopt(id: string, opinionId: string): Promise<Decision>;
    claim(id: string): Promise<void>;
    thread(id: string): Promise<DecisionComment[]>;
    comment(id: string, body: string): Promise<DecisionComment>;
  };
  item(repo: RepoName, number: number): Promise<Item>;
  /** Top bar: jumps by number, logins, words in titles and bodies. */
  search(q: string): Promise<SearchHit[]>;
  /** The Items browser: every tracked repo, full-text search over titles, bodies and comments. */
  items(filter: ItemFilter): Promise<ItemList>;
  progress(): Promise<Progress>;
  /** Anyone signed in reads; writes and the preview are for operators. Override notes come only to operators. */
  contributors: {
    list(filter: ContributorFilter): Promise<ContributorList>;
    previewRule(rule: WhitelistRule): Promise<RulePreview>;
    setRule(rule: WhitelistRule): Promise<WhitelistRule>;
    override(login: string, input: OverrideInput): Promise<Contributor>;
  };
  /** Operator only: every org repo and whether it is tracked. */
  repoAdmin: {
    list(): Promise<TrackedRepo[]>;
    track(name: RepoName): Promise<TrackedRepo[]>;
    untrack(name: RepoName): Promise<TrackedRepo[]>;
    /** Lets the Label stage write labels to this repo on GitHub, or stops it. */
    approveLabels(name: RepoName, approved: boolean): Promise<TrackedRepo[]>;
  };
  /** Operator only. */
  access: {
    overview(): Promise<AccessOverview>;
    add(input: { login: string; role: Role; note?: string }): Promise<AccessOverview>;
    remove(login: string): Promise<AccessOverview>;
    setRole(login: string, role: Role): Promise<AccessOverview>;
    revokeSession(id: number): Promise<AccessOverview>;
    audit(filter: AuditFilter): Promise<AuditPage>;
  };
  classifiers: {
    /** `run`, `a` and `b` default to the latest run and its first pair. */
    report(sel: { run?: string; a?: string; b?: string }): Promise<ClassifierReport>;
    disagreements(filter: DisagreementFilter): Promise<DisagreementList>;
  };
  /** Token use and spend for one run, or all runs when `run` is empty. */
  cost(run?: string): Promise<CostReport>;
  /** Steps, jobs and schedules: everyone reads; run, cancel and schedule are for operators. */
  pipeline: {
    overview(): Promise<PipelineOverview>;
    jobs(filter: JobFilter): Promise<JobList>;
    job(id: number): Promise<JobDetail>;
    run(step: string, params: JobParams): Promise<Job>;
    cancel(id: number): Promise<Job>;
    schedule(step: string, input: ScheduleInput): Promise<Schedule>;
  };
  /** Every registered model prompt, with the server's commit. */
  prompts(): Promise<PromptsReport>;
  signOut(): Promise<void>;
  /** Called after any write so open views can refetch. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiContext missing");
  return api;
}

export interface Query<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  refetch: () => void;
}

/**
 * Minimal data hook: runs `fn` when `key` changes and after every API write.
 * Keeps the previous data while a refetch is in flight so lists don't flash.
 */
export function useQuery<T>(key: string, fn: (api: Api) => Promise<T>): Query<T> {
  const api = useApi();
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const run = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fnRef.current(api).then(
      (data) => mine === seq.current && setState({ data, loading: false }),
      (error: Error) => mine === seq.current && setState((s) => ({ ...s, error, loading: false })),
    );
  }, [api]);

  useEffect(run, [run, key]);
  useEffect(() => api.subscribe(run), [api, run]);

  return { ...state, refetch: run };
}
