// Input and limits of the scope recommendation prompt. No Node imports: the prompt registry imports this file.

/** One scope decision as the recommendation prompt sees it. */
export type RecommendInput = {
  /** "repo#number" of the item. */
  ref: string;
  /** Where the call may read the default-branch checkout inside the sandbox; not part of the quoted JSON. */
  repo_dir?: string;
  /** Names of the shared repositories mounted at /shared/<name> (sorted); not part of the quoted JSON. */
  shared_repos?: string[];
  /** The item as the summary prompt sees it: title, body, author association, labels, first comments. */
  item: Record<string, unknown>;
  question: string;
  facts: string[];
  summary: string;
  options: { key: string; label: string; hint: string }[];
};

export const RECOMMEND_REASON_MAX = 200;
export const RECOMMEND_BODY_LIMIT = 4000;

export const SAMPLE_RECOMMEND: RecommendInput[] = [{
  ref: "photocraft#1562",
  item: {
    ref: "photocraft#1562", kind: "issue", title: "Add an in-app AI assistant for 16-bit PNG cleanup",
    body: "Adds an assistant panel. The default endpoint is our hosted service (paid plan). The reference app has this, see docs/gaps.md row 14.",
    author_association: "NONE", labels: ["enhancement"], comments: [],
  },
  question: "Is this wanted in core?",
  facts: ["photocraft issue, opened 3 days ago, 0 comments", "author: someone, new contributor"],
  summary: "It asks for an assistant panel that sends the document to a hosted service. The author says the reference application has this. It is unclear whether it does and who runs the default service.",
  options: [
    { key: "take", label: "Wanted in core", hint: "In scope: brings us closer to the reference app. Keep open; PRs go to review." },
    { key: "plugin", label: "Plug-in candidate", hint: "Not for core. Keep open and label it plugin candidate." },
    { key: "need-info", label: "Check the reference app", hint: "Ask how the reference app behaves before deciding." },
    { key: "close", label: "Out of scope", hint: "Not wanted. Close with a short reason." },
  ],
}];
