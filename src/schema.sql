-- Mirror tables: written only by `craft-auto sync`, overwritten from GitHub.

CREATE TABLE IF NOT EXISTS repos (
  name TEXT PRIMARY KEY,              -- "photocraft" (owner is always storytold)
  visibility TEXT,
  default_branch TEXT,
  open_prs INTEGER,
  open_issues INTEGER,
  synced_at TEXT,                     -- ISO time of the last finished sync
  high_water TEXT                     -- max updatedAt seen; incremental syncs stop below it
);

CREATE TABLE IF NOT EXISTS items (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- 'pr' | 'issue'
  state TEXT NOT NULL,                -- 'OPEN' | 'CLOSED' | 'MERGED'
  title TEXT, body TEXT, url TEXT,
  author TEXT, author_association TEXT,
  created_at TEXT, updated_at TEXT, closed_at TEXT, merged_at TEXT,
  merged_by TEXT,
  state_reason TEXT,                  -- issues: COMPLETED | NOT_PLANNED | DUPLICATE
  is_draft INTEGER,
  labels TEXT,                        -- JSON array of names
  assignees TEXT,                     -- JSON array of logins
  comments_count INTEGER,
  -- PR only
  additions INTEGER, deletions INTEGER, changed_files INTEGER,
  head_ref TEXT, head_oid TEXT, head_repo TEXT, base_ref TEXT,
  maintainer_can_modify INTEGER,
  mergeable TEXT,                     -- MERGEABLE | CONFLICTING | UNKNOWN
  review_decision TEXT,
  ci_state TEXT,                      -- statusCheckRollup state of the head commit
  closing_issues TEXT,                -- JSON array of issue numbers
  detail_level TEXT,                  -- 'full' (open: comments, reviews) | 'light' (closed)
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS items_state ON items(repo, kind, state);
CREATE INDEX IF NOT EXISTS items_author ON items(author);

CREATE TABLE IF NOT EXISTS comments (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  id TEXT PRIMARY KEY,                -- GraphQL node id
  kind TEXT,                          -- 'comment' | 'review'
  author TEXT, created_at TEXT, body TEXT,
  review_state TEXT,                  -- reviews: APPROVED | CHANGES_REQUESTED | COMMENTED
  commit_oid TEXT
);
CREATE INDEX IF NOT EXISTS comments_item ON comments(repo, number);

-- Work tables: ours, never touched by sync.

-- One row per classifier verdict; several classifiers may judge the same item.
CREATE TABLE IF NOT EXISTS classifications (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  classifier TEXT NOT NULL,           -- 'haiku' | 'jev' | 'sonnet' | 'owner'
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  type_label TEXT,                    -- bugfix | performance | missing feature | small extra | plugin candidate | infra
  want TEXT,                          -- yes | no | unclear
  reference TEXT,                     -- claimed reference-app behaviour, or NULL
  topics TEXT,                        -- '1' | 'many'
  flags TEXT,                         -- JSON array
  dup_of INTEGER,
  area TEXT,
  reason TEXT,
  probs TEXT,                         -- JSON, Jev: {type: {label: p}, top, security, needs_decision}
  PRIMARY KEY (repo, number, classifier, run_id)
);

-- Where each item stands in the pipeline (latest row wins).
CREATE TABLE IF NOT EXISTS stages (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  stage TEXT NOT NULL,                -- classified | reviewed | take | hold | close | needs-decision | batched | merged | closed | fixed-by-us
  at TEXT NOT NULL,
  actor TEXT,                         -- session or agent name
  note TEXT,                          -- one line, public-safe
  docket TEXT                         -- Docket issue key when a decision is asked there
);
CREATE INDEX IF NOT EXISTS stages_item ON stages(repo, number, at);

-- Contributor whitelist: the automatic tier comes from merge history;
-- an override from the owner always wins.
CREATE TABLE IF NOT EXISTS whitelist_overrides (
  login TEXT PRIMARY KEY,
  status TEXT NOT NULL,               -- 'allow' | 'deny'
  note TEXT,                          -- private: never in a public export
  by TEXT, at TEXT
);

-- Token use per agent run, for cost per item and stage.
CREATE TABLE IF NOT EXISTS token_usage (
  run_id TEXT NOT NULL, agent TEXT NOT NULL,
  stage TEXT, model TEXT, repo TEXT,
  items INTEGER,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  started_at TEXT, ended_at TEXT,
  cost_usd REAL,                      -- as reported by the CLI, when it reports one
  PRIMARY KEY (run_id, agent)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
-- whitelist rule defaults; editable with `craft-auto whitelist rule`
INSERT OR IGNORE INTO settings VALUES ('whitelist_min_merged', '5');
INSERT OR IGNORE INTO settings VALUES ('whitelist_min_merge_rate', '0.6');

-- Decisions for people. The pipeline asks; only a signed-in person on the
-- dashboard answers (spec: docs/dashboard-spec.md).
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- scope | duplicate | close | merge | split | other
  repo TEXT,                          -- null only for a batch spanning repos
  number INTEGER,                     -- null for a batch
  items TEXT,                         -- batch: JSON [{repo, number}]
  question TEXT NOT NULL,
  context TEXT,
  facts TEXT,                         -- JSON array of short strings
  options TEXT NOT NULL,              -- JSON [{key, label}]
  recommended TEXT,
  public_text TEXT,
  asked_at TEXT NOT NULL, asked_by TEXT,
  docket TEXT,
  answer TEXT, answer_note TEXT,      -- answer_note is private
  exceptions TEXT,                    -- batch: JSON [{repo, number, answer}]
  answered_by TEXT, answered_at TEXT,
  applied_at TEXT,
  summary TEXT, summary_by TEXT, summary_at TEXT,  -- AI summary of the item or batch, by which model, when
  adopted_opinion TEXT                -- decision_opinions.id when the answer adopted an opinion
);
CREATE INDEX IF NOT EXISTS decisions_open ON decisions(answer, kind, repo);
-- db.ts adds the summary and adopted_opinion columns to databases created before them.

-- Opinions: non-binding picks by anyone signed in. Display-only: the pipeline
-- and every CLI command agents run never read this table or decision_comments.
CREATE TABLE IF NOT EXISTS decision_opinions (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  login TEXT NOT NULL COLLATE NOCASE,
  option TEXT,                        -- option key, or NULL for a note only
  note TEXT,
  at TEXT NOT NULL,
  permission TEXT NOT NULL,           -- the login's GitHub permission on the repo when given: write | none
  retracted_at TEXT                   -- set when changed or retracted; one live row per login and decision
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_opinions_live ON decision_opinions(decision_id, login) WHERE retracted_at IS NULL;

CREATE TABLE IF NOT EXISTS decision_comments (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  login TEXT NOT NULL COLLATE NOCASE,
  at TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_comments_decision ON decision_comments(decision_id, at);

-- Who is looking at a decision; a claim lapses after 10 minutes without activity.
CREATE TABLE IF NOT EXISTS decision_claims (
  decision_id TEXT NOT NULL,
  login TEXT NOT NULL COLLATE NOCASE,
  since TEXT NOT NULL,                -- when this look started
  at TEXT NOT NULL,                   -- last activity
  PRIMARY KEY (decision_id, login)
);

-- Accounts. Only logins on the access list can sign in.
CREATE TABLE IF NOT EXISTS access (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  role TEXT NOT NULL,                 -- operator | maintainer | viewer
  added_by TEXT, added_at TEXT,
  note TEXT                           -- private
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,           -- sha256 of the cookie value
  login TEXT NOT NULL COLLATE NOCASE,
  csrf TEXT NOT NULL,
  token_enc TEXT,                     -- user's GitHub token, encrypted with the session key
  created_at TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_login ON sessions(login);

CREATE TABLE IF NOT EXISTS repo_permissions (
  login TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL,
  permission TEXT NOT NULL,           -- admin | maintain | write | triage | read | none
  checked_at TEXT NOT NULL,
  PRIMARY KEY (login, repo)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,             -- PKCE code verifier
  return_to TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  at TEXT NOT NULL,
  login TEXT NOT NULL,
  action TEXT NOT NULL,               -- answer | undo | adopt | opinion | opinion-retract | comment | override | rule | access-add | access-remove | access-role | session-revoke | sign-in | sign-in-refused | repo-track | repo-untrack
  target TEXT,
  details TEXT                        -- JSON
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS audit_target ON audit(target);

-- Dashboard query indexes.
CREATE INDEX IF NOT EXISTS items_closed ON items(closed_at, state);
CREATE INDEX IF NOT EXISTS items_created ON items(created_at);
CREATE INDEX IF NOT EXISTS items_pr_author ON items(kind, author, state, repo, merged_at);
CREATE INDEX IF NOT EXISTS items_open ON items(state, repo, number);
CREATE INDEX IF NOT EXISTS classifications_run ON classifications(run_id, classifier, repo, number);
CREATE INDEX IF NOT EXISTS token_usage_run ON token_usage(run_id, stage, model);

-- Repos the dashboard, pipeline and sync work on. `repos` keeps every org repo
-- (metadata only for untracked ones); operators choose here.
CREATE TABLE IF NOT EXISTS tracked_repos (
  name TEXT PRIMARY KEY,
  added_by TEXT,
  added_at TEXT
);
-- Seeded once; the flag keeps the seed from returning after an operator empties the list.
INSERT INTO tracked_repos (name, added_by, added_at)
SELECT column1, 'seed', strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM (VALUES
  ('photocraft'),
  ('pdfcraft'),
  ('wordcraft'),
  ('filmcraft'),
  ('gridcraft'),
  ('lightcraft'),
  ('cadcraft'),
  ('vectorcraft'),
  ('effectcraft'),
  ('designcraft'),
  ('deckcraft'),
  ('artcraft'),
  ('soundcraft'),
  ('figcraft'),
  ('texturecraft'),
  ('materialcraft'),
  ('stencilcraft'),
  ('craft-libs'),
  ('craft-launcher'),
  ('craft-anything'),
  ('craft-i18n'),
  ('craft-fonts'),
  ('font-preview-service'),
  ('artcraft-services'),
  ('egui'),
  ('winit')
) WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'tracked_seeded')
  AND NOT EXISTS (SELECT 1 FROM tracked_repos);
INSERT OR IGNORE INTO settings VALUES ('tracked_seeded', '1');
