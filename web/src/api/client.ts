import { keepPreviousData, useInfiniteQuery, useQuery as useTanstackQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext } from "react";
import { topicsFor } from "./topics";
import type {
  ReleaseAction,
  AccessOverview,
  AccountInput,
  AgentRunDetail,
  AgentRunFilter,
  AgentRunPage,
  ClaudeAccount,
  UsagePause,
  Rates,
  AnswerInput,
  AuditFilter,
  AuditPage,
  GithubActivityFilter,
  GithubActivityPage,
  Contributor,
  ContributorFilter,
  ContributorList,
  ClassifierReport,
  CostReport,
  Decision,
  Flow,
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
  BatchFilter,
  BatchList,
  QueueFilter,
  QueueList,
  WorkFilter,
  WorkList,
  RepoName,
  Role,
  RulePreview,
  SearchHit,
  SimilarHit,
  TrackedRepo,
  User,
  WhitelistRule,
  Job,
  JobDetail,
  JobFilter,
  JobList,
  JobParams,
  PipelineOverview,
  PipelineState,
  StageLimit,
  BuildEnv,
  BuildSummary,
  BuildTask,
  BuildTaskDetail,
  EnvCreate,
  EnvInput,
  TaskFilter,
  TaskPage,
} from "./types";

/** The dashboard API as the frontend sees it. The mock and the HTTP client both implement it. */
export interface Api {
  me(): Promise<User>;
  repos(): Promise<RepoName[]>;
  decisions: {
    list(filter: DecisionFilter): Promise<DecisionList>;
    get(id: string): Promise<Decision>;
    /** The decision a readable link opens: the item's first open one, else its latest; null when it has none. */
    forItem(repo: RepoName, number: number): Promise<Decision | null>;
    answer(id: string, input: AnswerInput): Promise<Decision>;
    undo(id: string): Promise<Decision>;
    /** Operator: clear a Backlog answer so the decision is open again. */
    reopen(id: string): Promise<Decision>;
    /** Give or change the signed-in user's opinion (anyone signed in). */
    opine(id: string, input: { option: string | null; note?: string }): Promise<Decision>;
    retract(id: string): Promise<Decision>;
    /** Operator only: answer with the opinion's option. */
    adopt(id: string, opinionId: string, textsHash?: string): Promise<Decision>;
    claim(id: string): Promise<void>;
    thread(id: string): Promise<DecisionComment[]>;
    comment(id: string, body: string): Promise<DecisionComment>;
  };
  item(repo: RepoName, number: number): Promise<Item>;
  /** Operator only: review the current head again, plan Verify again, or try the issue fix again. Writes nothing to GitHub. */
  release(repo: RepoName, number: number, action: ReleaseAction): Promise<void>;
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
    /** Lets the pipeline merge pull requests in this repo, or stops it. */
    approveMerging(name: RepoName, approved: boolean): Promise<TrackedRepo[]>;
    /** Most ready pull requests of a repo that merge one at a time instead of in a batch; 0 always batches. */
    singleMerge(): Promise<{ max: number }>;
    setSingleMerge(max: number): Promise<{ max: number }>;
    /** Lets the Fix-up step push commits to contributor branches here, or stops it. */
    approvePushing(name: RepoName, approved: boolean): Promise<TrackedRepo[]>;
    /** Lets the Act step comment on and close items here, or stops it. */
    approveCommenting(name: RepoName, approved: boolean): Promise<TrackedRepo[]>;
    /** Lets the Fix issues step push fixes, open pull requests and comment on issues here, or stops it. */
    approveFixing(name: RepoName, approved: boolean): Promise<TrackedRepo[]>;
    /** Switches the pipeline stages on or off for this repo (off: sync only). */
    setPipeline(name: RepoName, on: boolean): Promise<TrackedRepo[]>;
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
  /** The merge queue: every PR with a take or take-fix review at its head, and what it waits on. */
  queue(filter: QueueFilter): Promise<QueueList>;
  /** Every write the app made on GitHub, newest first. */
  githubActivity(filter: GithubActivityFilter): Promise<GithubActivityPage>;
  /** Integration batches of the merge queue, newest first, with their member PRs. */
  queueBatches(filter: BatchFilter): Promise<BatchList>;
  /** Steps, jobs, the on/off switch and the stage limits: everyone reads; run, cancel, switch and limits are for operators. */
  pipeline: {
    overview(): Promise<PipelineOverview>;
    jobs(filter: JobFilter): Promise<JobList>;
    job(id: number): Promise<JobDetail>;
    run(step: string, params: JobParams): Promise<Job>;
    cancel(id: number): Promise<Job>;
    state(): Promise<PipelineState>;
    setEnabled(enabled: boolean): Promise<PipelineState>;
    setLimit(step: string, limit: { perDay: number | null }): Promise<StageLimit>;
    /** Counts the stage's items today from zero again; `all` resets every stage. */
    resetLimit(step: string): Promise<PipelineState>;
    /** Limits the whole pipeline to these items ("repo#number"); an empty list clears the pilot. */
    setPilot(items: string[]): Promise<PipelineState>;
  };
  /** The pipeline as a flowchart: every stage with its branches and counts, for every tracked repo or one. */
  flow(repo?: RepoName): Promise<Flow>;

  /** Enabled accounts for everyone; operators also see disabled ones and edit label, enabled and max concurrent. Never an email or path. */
  accounts: {
    list(): Promise<ClaudeAccount[]>;
    pause(): Promise<UsagePause>;
    /** Operators. */
    setPause(input: UsagePause): Promise<UsagePause>;
    update(id: string, input: AccountInput): Promise<ClaudeAccount>;
    /** Operators: a new, disabled, signed-out account with this label. */
    add(label: string): Promise<ClaudeAccount>;
    /** Starts a sign-in; the answer's `login.url` is the page to open. */
    loginStart(id: string): Promise<ClaudeAccount>;
    /** Sends the code the sign-in page showed. */
    loginCode(id: string, code: string): Promise<ClaudeAccount>;
    loginCancel(id: string): Promise<ClaudeAccount>;
    signOut(id: string): Promise<ClaudeAccount>;
    /** Reads sign-in state and plan usage now. */
    refresh(id: string): Promise<ClaudeAccount>;
  };
  /** Agent runs (one model call each): keyset-paged, filtered on the server. */
  agents: {
    list(filter: AgentRunFilter): Promise<AgentRunPage>;
    get(id: number): Promise<AgentRunDetail>;
  };
  /** Build environments (workers that run untrusted code) and their tasks. Everyone reads; operators write. A worker key is returned once. */
  envs: {
    list(): Promise<BuildEnv[]>;
    create(input: EnvCreate): Promise<{ env: BuildEnv; key: string }>;
    update(id: string, input: EnvInput): Promise<BuildEnv>;
    rotateKey(id: string): Promise<{ key: string }>;
  };
  tasks: {
    list(filter: TaskFilter): Promise<TaskPage>;
    get(id: number): Promise<BuildTaskDetail>;
    cancel(id: number): Promise<BuildTask>;
    /** Queued and running tasks and free slots, for the flowchart's Verify node. */
    summary(): Promise<BuildSummary>;
  };
  /** Items moved per stage and account use over time. */
  rates(window: "24h" | "7d"): Promise<Rates>;
  /** Every registered model prompt, with the server's commit. */
  prompts(): Promise<PromptsReport>;
  signOut(): Promise<void>;
  /** Called after any write so open views can refetch. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  /** Nearest items by embedding across the tracked repos, best first, leaving out the item itself. */
  similar(repo: RepoName, number: number, limit?: number): Promise<SimilarHit[]>;
  /** Search by meaning: the query's embedding against every item's. */
  semanticSearch(q: string): Promise<SimilarHit[]>;
  /** Open items in work-score order with the parts of each score and the next pipeline step. Read-only. */
  work(filter: WorkFilter): Promise<WorkList>;
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
 * A server view in the shared cache. `key` identifies the view (it must contain every input of `fn`);
 * the topics it reads come from api/topics.ts, and the server's change events refetch it. The
 * previous data stays while a refetch is in flight so lists don't flash. `pollMs` is for views that
 * change without a database write (a log file being written); it runs only while the tab is visible.
 */
export function useQuery<T>(key: string, fn: (api: Api) => Promise<T>, opts: { pollMs?: number | false | ((data: T | undefined) => number | false); enabled?: boolean } = {}): Query<T> {
  const api = useApi();
  const q = useTanstackQuery<T, Error>({
    queryKey: [key],
    queryFn: () => fn(api),
    meta: { topics: topicsFor(key) },
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
    refetchInterval: typeof opts.pollMs === "function" ? (query) => (opts.pollMs as (d: T | undefined) => number | false)(query.state.data) : opts.pollMs || false,
  });
  const { refetch } = q;
  const again = useCallback(() => void refetch(), [refetch]);
  // A pushed refetch replaces the data in place; only a first load or a new key (data shown is the old key's) counts as loading.
  return { data: q.data, error: q.error ?? undefined, loading: q.isPending || q.isPlaceholderData, refetch: again };
}

export interface PagedQuery<P> {
  /** Every loaded page, first to last; undefined until the first one arrives. */
  pages?: P[];
  error?: Error;
  /** True while the first page loads, or while a new key's pages load over the old key's; pushed refetches don't count. */
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

/**
 * A cursor-paged list in the shared cache. A change event refetches every loaded page in order, so
 * "Show more" keeps its place. `next` gives the cursor of the page after `page`, or null on the last one.
 */
export function usePagedQuery<P>(key: string, fn: (api: Api, cursor: string | undefined) => Promise<P>, next: (page: P) => string | null | undefined): PagedQuery<P> {
  const api = useApi();
  const q = useInfiniteQuery<P, Error, { pages: P[] }, string[], string | undefined>({
    queryKey: [key],
    queryFn: ({ pageParam }) => fn(api, pageParam),
    initialPageParam: undefined,
    getNextPageParam: (last) => next(last) ?? undefined,
    meta: { topics: topicsFor(key) },
    placeholderData: keepPreviousData,
  });
  const { refetch, fetchNextPage } = q;
  return {
    pages: q.data?.pages,
    error: q.error ?? undefined,
    loading: q.isPending || q.isPlaceholderData,
    hasMore: !!q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: useCallback(() => void fetchNextPage(), [fetchNextPage]),
    refetch: useCallback(() => void refetch(), [refetch]),
  };
}
