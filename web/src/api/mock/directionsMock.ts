import type { Api } from "../client";
import type { DirectionProposal, DirectionView, RepoDirections, User } from "../types";
import { NOW } from "./fixtures";

const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const SEED: DirectionView[] = [
  {
    id: 1, repo: "*", createdBy: "mosswood", createdAt: ago(72), sourceDecision: "designcraft#2188:duplicate", retiredAt: null,
    sourceItem: { repo: "designcraft", number: 2188, kind: "issue", state: "open", title: "Snap to pixel grid breaks with rotated frames" },
    text: "Hyphenation, spelling, dictionaries and other language data belong in craft-libs (craft-text, craft-proof) and craft-i18n language packs, not in the app.",
  },
  { id: 2, repo: "photocraft", createdBy: "ochre-fox", createdAt: ago(30), sourceDecision: null, sourceItem: null, retiredAt: null, text: "New file formats are added as codec crates, not inside the canvas code." },
  { id: 3, repo: "photocraft", createdBy: "ochre-fox", createdAt: ago(240), sourceDecision: null, sourceItem: null, retiredAt: ago(48), text: "Keep the plugin API frozen until the 2.0 release." },
];

const PROPOSAL: DirectionProposal = {
  id: 1, repo: "designcraft", number: 2188, decisionId: "designcraft#2188:duplicate", createdAt: ago(5),
  note: "Close. Hyphenation and dictionaries belong in craft-libs, not in the app.",
  draft: "Language features such as hyphenation and dictionaries belong in craft-libs, not in the app.",
};

export function createDirectionsMock(me: User, changed: () => void): Pick<Api, "directions"> {
  const dirs = structuredClone(SEED);
  let proposals = [structuredClone(PROPOSAL)];
  let next = 10;
  const need = () => {
    if (me.role !== "operator") throw new Error("only operators change directions");
  };
  const view = (repo: string): RepoDirections => ({
    repo,
    directions: dirs.filter((d) => !d.retiredAt && (d.repo === repo || d.repo === "*")),
    retired: dirs.filter((d) => d.retiredAt && (d.repo === repo || d.repo === "*")).reverse(),
    proposals: me.role === "operator" ? proposals.filter((p) => p.repo === repo) : [],
  });
  const wait = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 40));
  const find = (id: number) => {
    const d = dirs.find((x) => x.id === id);
    if (!d) throw new Error("no such direction");
    return d;
  };
  return {
    directions: {
      get: (repo) => wait(view(repo)),
      async add(repo, body) {
        need();
        const text = body.text.trim();
        if (!text) throw new Error("a direction needs text");
        dirs.push({ id: next++, repo: body.allRepos ? "*" : repo, text, createdBy: me.login, createdAt: new Date(NOW).toISOString(), sourceDecision: null, sourceItem: null, retiredAt: null });
        changed();
        return wait(view(repo));
      },
      async edit(id, text) {
        need();
        find(id).text = text.trim();
        changed();
      },
      async retire(id) {
        need();
        find(id).retiredAt = new Date(NOW).toISOString();
        changed();
      },
      async acceptProposal(id, body) {
        need();
        const p = proposals.find((x) => x.id === id);
        if (!p) throw new Error("no open proposal with that id");
        dirs.push({ id: next++, repo: body?.allRepos ? "*" : p.repo, text: (body?.text ?? p.draft).trim(), createdBy: me.login, createdAt: new Date(NOW).toISOString(), sourceDecision: p.decisionId, sourceItem: null, retiredAt: null });
        proposals = proposals.filter((x) => x.id !== id);
        changed();
      },
      async dismissProposal(id) {
        need();
        proposals = proposals.filter((x) => x.id !== id);
        changed();
      },
      forDecision: (decisionId) => wait({ proposals: me.role === "operator" ? proposals.filter((p) => p.decisionId === decisionId) : [] }),
    },
  };
}
