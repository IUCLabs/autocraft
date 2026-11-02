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
  stage TEXT NOT NULL,                -- classified | labeled | reviewed | take | hold | close | needs-decision | batched | merged | closed | fixed-by-us
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
  action TEXT NOT NULL,               -- answer | undo | adopt | opinion | opinion-retract | comment | override | rule | access-add | access-remove | access-role | session-revoke | sign-in | sign-in-refused | repo-track | repo-untrack | labels-approve | labels-revoke | labels-apply | assign | merge | merge-refused | job-request | job-cancel | pipeline-switch | stage-limit
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

-- Pipeline jobs: the only channel from the dashboard to the runner
-- (`craft-auto runner serve`). The dashboard inserts requests and cancel
-- marks; the runner claims, runs and finishes jobs. Steps are defined in code
-- (src/runner/steps.ts); params are validated against the step's schema
-- before a row is written.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step TEXT NOT NULL,
  params TEXT NOT NULL,               -- JSON object, validated
  requested_by TEXT NOT NULL,         -- login, 'pipeline' (autopilot) or 'cli'
  requested_at TEXT NOT NULL,
  state TEXT NOT NULL,                -- queued | running | done | failed | cancelled
  started_at TEXT, ended_at TEXT,
  progress TEXT,                      -- one line, set while running
  summary TEXT,                       -- one line when done
  error TEXT,                         -- one line when failed
  usage TEXT,                         -- JSON {calls, input, output, costUsd} of model calls made by the job
  log_path TEXT,                      -- runner-side file; never sent to the browser
  pid INTEGER,                        -- the job's child process while running
  cancel_requested_at TEXT,
  cancel_requested_by TEXT,
  items INTEGER                       -- items the job handled (classified, asked, reviewed, merged ...), for the daily limits
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, id);
CREATE INDEX IF NOT EXISTS jobs_step ON jobs(step, id);

-- Daily limits per autopilot stage (UTC day); NULL means no limit, 0 pauses the
-- stage. The pipeline switch itself lives in settings (pipeline_enabled,
-- pipeline_changed_by, pipeline_changed_at).
CREATE TABLE IF NOT EXISTS stage_limits (
  step TEXT PRIMARY KEY,
  per_day INTEGER,                    -- items per day
  updated_by TEXT, updated_at TEXT
);
INSERT OR IGNORE INTO stage_limits (step, per_day) VALUES
  ('classify-new', 2000), ('embed', NULL), ('decide', 100), ('checks', NULL),
  ('review-batch', 40), ('labels-apply', NULL), ('merge', 10);

-- One row per `craft-auto sync` run, kept for two days, for the Pipeline page.
CREATE TABLE IF NOT EXISTS sync_runs (
  started_at TEXT NOT NULL,
  ended_at TEXT,
  mode TEXT,
  items INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_started ON sync_runs(started_at);

-- CI and merge state of open PRs at their head commit, for review candidates.
-- Written by `craft-auto checks` and the Review stage; sync never touches it.
CREATE TABLE IF NOT EXISTS pr_checks (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  state TEXT,                         -- OPEN | CLOSED | MERGED at fetch time
  is_draft INTEGER,
  overall TEXT NOT NULL,              -- success | failure | pending | none (no checks ran)
  checks TEXT NOT NULL,               -- JSON [{name, state}]; state: success | failure | pending | skipped
  mergeable TEXT,                     -- MERGEABLE | CONFLICTING | UNKNOWN
  maintainer_can_modify INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

-- One code review per PR head commit. A new push gets a new review; the
-- latest row per item is its current verdict. Each review also writes a
-- `reviewed` stages row and a take/hold/close stages row.
CREATE TABLE IF NOT EXISTS reviews (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  model TEXT,                         -- NULL when no model was asked (too large)
  size TEXT,                          -- S | M | L by lines changed
  verdict TEXT NOT NULL,              -- take | take-fix | hold | close
  reason TEXT NOT NULL,
  fixes TEXT,                         -- JSON [{file, change}], take-fix only
  duplicate_of TEXT,                  -- "repo#n" of the better PR
  overlaps TEXT,                      -- JSON ["repo#n"]: open PRs changing the same code
  risks TEXT,                         -- JSON [string]
  PRIMARY KEY (repo, number, head_oid)
);
CREATE INDEX IF NOT EXISTS reviews_run ON reviews(run_id);

-- Merge attempts by the Integrate stage, one row per try at a PR head.
-- outcome: merged | refused (the merge command or a pre-merge check said no, with why).
CREATE TABLE IF NOT EXISTS merges (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  path TEXT NOT NULL,                 -- rule (merge without asking) | operator (answered Merge? decision)
  method TEXT,                        -- squash | merge; null when refused before the command ran
  outcome TEXT NOT NULL,              -- merged | refused
  reason TEXT                         -- one line, public-safe
);
CREATE INDEX IF NOT EXISTS merges_item ON merges(repo, number, at);

-- Full-text search over item titles and bodies and comment bodies. Both are
-- external-content tables (the text stays in items and comments only), kept
-- current by these triggers; db.ts builds them once for an existing database.
-- The sync writes items with an upsert, which keeps their rowids, and connect()
-- turns on recursive_triggers so an INSERT OR REPLACE also runs the delete triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, body, content='items', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  body, content='comments', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');

CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE OF title, body ON items
WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.rowid <> new.rowid BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO items_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_fts_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_fts_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts (comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_fts_au AFTER UPDATE OF body ON comments
WHEN old.body IS NOT new.body OR old.rowid <> new.rowid BEGIN
  INSERT INTO comments_fts (comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO comments_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE INDEX IF NOT EXISTS items_updated ON items(updated_at);
CREATE INDEX IF NOT EXISTS items_state_updated ON items(state, updated_at);
CREATE INDEX IF NOT EXISTS items_author_nocase ON items(author COLLATE NOCASE);

-- Sentence embeddings of tracked items, for similar items and semantic search.
-- Written by `craft-auto embed` (src/embed/); the dashboard only reads them.
CREATE TABLE IF NOT EXISTS item_embeddings (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  model TEXT NOT NULL,                -- embedder id: "<model>:<dtype>:<max tokens>"; another model's rows count as missing
  hash TEXT NOT NULL,                 -- of the embedded text (src/embed/text.ts), so only changed items are embedded again
  vec BLOB NOT NULL,                  -- float32, little-endian, unit length
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

-- Claude accounts an operator may enable. A row exists for each account in the
-- box config (CRAFT_AUTO_ACCOUNTS); the config directory is never stored here.
CREATE TABLE IF NOT EXISTS claude_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,                -- the only name shown to people
  enabled INTEGER NOT NULL DEFAULT 0,
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  updated_by TEXT,
  updated_at TEXT
);

-- Usage readings, written by the runner when a reading changes; kept 30 days.
-- t is the reading's own time (ISO), so a reading is recorded once.
CREATE TABLE IF NOT EXISTS account_usage_samples (
  account_id TEXT NOT NULL,
  t TEXT NOT NULL,
  five_hour_pct REAL,
  weekly_pct REAL,
  PRIMARY KEY (account_id, t)
) WITHOUT ROWID;

-- One row per model call made through the prompt registry. Ids grow with time,
-- so newest-first paging is a keyset on id. Prompt and output text live in
-- agent_run_texts, which is pruned after 14 days; runs are kept 90 days.
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  step TEXT NOT NULL,
  stage INTEGER NOT NULL,
  prompt_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,             -- claude | jev
  model TEXT NOT NULL,
  account_id TEXT,                    -- null for Jev
  items TEXT NOT NULL DEFAULT '[]',   -- JSON [{repo, number}], at most 50
  item_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,                -- running | done | failed
  started_at TEXT NOT NULL,
  ended_at TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  summary TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_running ON agent_runs(account_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS agent_runs_state ON agent_runs(state, id);
CREATE INDEX IF NOT EXISTS agent_runs_step ON agent_runs(step, id);
CREATE INDEX IF NOT EXISTS agent_runs_account ON agent_runs(account_id, id);
CREATE INDEX IF NOT EXISTS agent_runs_job ON agent_runs(job_id, id);
CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started_at);

CREATE TABLE IF NOT EXISTS agent_run_items (
  run_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  PRIMARY KEY (run_id, repo, number)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS agent_run_items_repo ON agent_run_items(repo, run_id, number);

CREATE TABLE IF NOT EXISTS agent_run_texts (
  run_id INTEGER PRIMARY KEY,
  prompt TEXT,
  output TEXT
);

CREATE INDEX IF NOT EXISTS jobs_started ON jobs(started_at);
