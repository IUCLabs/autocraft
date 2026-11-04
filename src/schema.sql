-- Mirror tables: written only by `autocraft sync`, overwritten from GitHub.

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
  embed_hash TEXT,                    -- hash of the embedded text, set at sync (src/itemhash.ts)
  class_hash TEXT,                    -- the classifier's input hash under class_scheme
  class_scheme TEXT,
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
CREATE INDEX IF NOT EXISTS comments_created ON comments(created_at);

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
  flags TEXT,                         -- JSON array
  dup_of INTEGER,
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

-- The latest stages row per item, kept by the trigger below so reads never scan
-- `stages`. A later `at` wins; at the same `at` the newer insert wins. `reviewed`
-- is 1 once the item has had a `reviewed` row. db.ts fills the table once for a
-- database that had stages before it existed.
CREATE TABLE IF NOT EXISTS item_stage (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  stage TEXT NOT NULL, at TEXT NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS stages_latest AFTER INSERT ON stages BEGIN
  INSERT INTO item_stage (repo, number, stage, at, reviewed) VALUES (NEW.repo, NEW.number, NEW.stage, NEW.at, NEW.stage = 'reviewed')
  ON CONFLICT (repo, number) DO UPDATE SET
    stage = CASE WHEN excluded.at >= item_stage.at THEN excluded.stage ELSE item_stage.stage END,
    at = CASE WHEN excluded.at >= item_stage.at THEN excluded.at ELSE item_stage.at END,
    reviewed = item_stage.reviewed OR excluded.reviewed;
END;

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
  cost_usd REAL,                      -- as reported by the CLI; Jev: input tokens at TypeSafe's price
  PRIMARY KEY (run_id, agent)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
-- whitelist rule defaults; editable with `autocraft whitelist rule`
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
  recommended_reason TEXT, recommended_by TEXT,
  recommend_failures INTEGER, recommend_failed_at TEXT,  -- recommendation calls that gave no valid answer, and the last one  -- one-sentence reason and the model that gave the recommendation (null: none from a model)
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
CREATE INDEX IF NOT EXISTS decisions_asked ON decisions(answer, asked_at);
CREATE INDEX IF NOT EXISTS decisions_answered ON decisions(answered_at);
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
CREATE INDEX IF NOT EXISTS decision_comments_at ON decision_comments(at);
CREATE INDEX IF NOT EXISTS decision_opinions_at ON decision_opinions(at);

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
  note TEXT,                          -- private
  github_id INTEGER                   -- numeric GitHub user id, bound at the first sign-in; later sign-ins must match
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
  action TEXT NOT NULL,               -- answer | undo | adopt | opinion | opinion-retract | comment | override | rule | access-add | access-remove | access-role | session-revoke | sign-in | sign-in-refused (at most one row per login per hour; details.refused counts them) | repo-track | repo-untrack | labels-approve | labels-revoke | merge-approve | merge-revoke | labels-apply | assign | merge | merge-refused | comment-approve | comment-revoke | review-post | review-edit | act-comment | act-close | act-skip | job-request | job-cancel | pipeline-switch | stage-limit | env-create | env-change | env-rotate-key | task-cancel | unassign | batch-again | ci-approve | ci-revoke | ci-run-approve
  target TEXT,
  details TEXT                        -- JSON
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS audit_target ON audit(target);
CREATE INDEX IF NOT EXISTS audit_assign ON audit(target) WHERE action IN ('assign', 'unassign');

-- Dashboard query indexes.
CREATE INDEX IF NOT EXISTS items_closed ON items(closed_at, state);
CREATE INDEX IF NOT EXISTS items_created ON items(created_at);
CREATE INDEX IF NOT EXISTS items_pr_author ON items(kind, author, state, repo, merged_at);
CREATE INDEX IF NOT EXISTS items_open ON items(state, repo, number);
CREATE INDEX IF NOT EXISTS classifications_run ON classifications(run_id, classifier, repo, number);
-- The newest verdict of a classifier (latestRun) without reading every row.
CREATE INDEX IF NOT EXISTS classifications_latest ON classifications(classifier, at);
CREATE INDEX IF NOT EXISTS classifications_dup ON classifications(repo, dup_of) WHERE dup_of IS NOT NULL;
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
-- (`autocraft runner serve`). The dashboard inserts requests and cancel
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
  repo TEXT,                          -- params.repo, for the autopilot's per-repo lookups
  items INTEGER,                      -- items the job handled (classified, asked, reviewed, merged ...), for the daily limits
  acted INTEGER                       -- other progress the job made (a batch advanced or opened, a decision asked ...); with items 0, the job was idle
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, id);
CREATE INDEX IF NOT EXISTS jobs_step ON jobs(step, id);
CREATE INDEX IF NOT EXISTS jobs_step_started ON jobs(step, started_at);
CREATE INDEX IF NOT EXISTS jobs_user_ended ON jobs(requested_by, ended_at);

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
  ('labels-apply', NULL), ('merge', 10), ('act', 20), ('fixup', 20), ('verify', 30), ('opus-review', 40);

-- One row per `autocraft sync` run, kept for two days, for the Pipeline page.
CREATE TABLE IF NOT EXISTS sync_runs (
  started_at TEXT NOT NULL,
  ended_at TEXT,
  mode TEXT,
  items INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_started ON sync_runs(started_at);

-- What the last live read of a PR's formal reviews found (changes-requested.ts); sync never touches it.
CREATE TABLE IF NOT EXISTS review_gates (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  blocked INTEGER,                    -- 1 when a reviewer with write access has changes requested; NULL before any read
  by_login TEXT,                      -- those reviewers, comma separated
  read_at TEXT,                       -- ISO time of the last successful read
  failures INTEGER NOT NULL DEFAULT 0, -- reads that failed since the last success
  PRIMARY KEY (repo, number)
);

-- CI and merge state of open PRs at their head commit, for review candidates.
-- Written by `autocraft checks` and the Review stage; sync never touches it.
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

-- The code review: one Opus pass per PR head commit.
CREATE TABLE IF NOT EXISTS opus_reviews (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  run_id TEXT,
  at TEXT NOT NULL,
  model TEXT,
  mode TEXT NOT NULL,                 -- full | delta
  base_head TEXT,                     -- delta: the head Opus had reviewed before
  verdict TEXT,                       -- take | take-fix | hold | close
  sure INTEGER,                       -- 1 when Opus is sure of its verdict
  reason TEXT,
  fixes TEXT,                         -- JSON [{file, change}], the complete list for take-fix
  risks TEXT,                         -- JSON [string]
  -- public_review (added column): JSON {summary, points}, the text posted on the PR; NULL when the reply had none
  PRIMARY KEY (repo, number, head_oid)
);

-- Every Opus review ever stored, appended with each write of opus_reviews (which keeps only the latest per head).
-- A take or take-fix with sure = 0 here keeps its head needing a person's Merge? answer even after a later review of the same head is sure.
CREATE TABLE IF NOT EXISTS opus_review_history (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  at TEXT NOT NULL,
  model TEXT, mode TEXT, verdict TEXT, sure INTEGER,
  reason TEXT, risks TEXT, fixes TEXT, summary TEXT, why TEXT, public_review TEXT
);
CREATE INDEX IF NOT EXISTS opus_review_history_head ON opus_review_history(repo, number, head_oid);

-- What a review did with the fixes of an earlier take-fix that were never applied (a new head came first): kept in
-- its fix list, explained in its reason, or unaddressed. One row per fix, replaced with the review of the head.
CREATE TABLE IF NOT EXISTS opus_carried_fixes (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,             -- the head the review was made at
  from_head TEXT NOT NULL,            -- the head of the take-fix that asked for the change
  file TEXT NOT NULL, change TEXT NOT NULL,
  outcome TEXT NOT NULL,              -- kept | explained | unaddressed
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS opus_carried_fixes_head ON opus_carried_fixes(repo, number, head_oid);

-- The verdict every later stage reads, per reviewed head commit: the Opus verdict.
-- A PR with no row here is not reviewed yet. An unsure take or take-fix keeps its verdict;
-- the merge queue asks a person before merging it.
DROP VIEW IF EXISTS final_reviews;
CREATE VIEW final_reviews AS
SELECT repo, number, head_oid, run_id, at, model, verdict, reason, fixes, risks, sure, mode, base_head, seen_at, disc_hash
FROM opus_reviews WHERE verdict IS NOT NULL;

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
  reason TEXT,                        -- one line, public-safe
  ci TEXT, mergeable TEXT             -- CI and mergeable state GitHub reported at the attempt
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
-- Written by `autocraft embed` (src/embed/); the dashboard only reads them.
CREATE TABLE IF NOT EXISTS item_embeddings (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  model TEXT NOT NULL,                -- embedder id: "<model>:<dtype>:<max tokens>"; another model's rows count as missing
  hash TEXT NOT NULL,                 -- of the embedded text (src/embed/text.ts), so only changed items are embedded again
  vec BLOB NOT NULL,                  -- float32, little-endian, unit length
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

-- Flowchart counts per repo (src/flow/), so the home page adds up a few hundred
-- small rows instead of counting the mirror. The runner refreshes the rows of
-- repos whose items, verdicts, decisions, reviews, checks or merges changed, and
-- every row at least every ten minutes; the dashboard counts a repo itself only
-- when it has no row yet.
CREATE TABLE IF NOT EXISTS flow_summary (
  repo TEXT PRIMARY KEY,
  counts TEXT NOT NULL,               -- JSON {key: count}, keys as in src/flow/count.ts
  counted_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,   -- 1: changed since counted_at, waiting for the next refresh
  decisions_sig TEXT                  -- the repo's decisions when counted, to notice answers and undos
);

-- Claude accounts an operator may enable. A row exists for each account in the
-- box config (AUTOCRAFT_ACCOUNTS); the config directory is never stored here.
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
-- agent_run_texts; both are kept 90 days.
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
  error TEXT,
  progress TEXT,                      -- running: the latest line of what the call is doing
  cost_usd REAL                       -- the call's cost in USD (Jev: input tokens times the flat price); null for rows from before this column
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

-- prompt and output are gzip BLOBs; rows written before compression hold plain text.
CREATE TABLE IF NOT EXISTS agent_run_texts (
  run_id INTEGER PRIMARY KEY,
  prompt TEXT,
  output TEXT
);

-- The tool uses of one model call (stream events), in order. Arguments are scrubbed and capped; only the size of a result is kept.
CREATE TABLE IF NOT EXISTS agent_run_tools (
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,                 -- JSON, at most 4000 characters
  result_bytes INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,                    -- arrival of the stream line; null for the non-streamed output form
  ended_at TEXT,
  check_id INTEGER,                   -- model_checks row, for the check tool
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS jobs_started ON jobs(started_at);

-- Build environments: places that run untrusted code (workers), registered by an
-- operator. The worker key is shown once and stored as a SHA-256 hash.
CREATE TABLE IF NOT EXISTS build_envs (
  id TEXT PRIMARY KEY,                -- lowercase letters, digits and hyphens
  label TEXT NOT NULL,                -- the only name shown to people
  kind TEXT NOT NULL,                 -- local-sandbox | remote
  enabled INTEGER NOT NULL DEFAULT 1,
  slots INTEGER NOT NULL,             -- the operator's cap; the worker may report fewer
  key_hash TEXT NOT NULL,
  capabilities TEXT,                  -- JSON Capabilities as last reported by the worker
  reported_slots INTEGER,
  version TEXT,
  paused_reason TEXT,                 -- as last reported by the worker
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);

-- Tasks: one unit of untrusted execution created by a pipeline step.
CREATE TABLE IF NOT EXISTS build_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  step TEXT NOT NULL,                 -- pipeline step that created it
  repo TEXT NOT NULL,
  number INTEGER,                     -- PR
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  requires TEXT NOT NULL,             -- JSON Requires
  priority INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL,                 -- JSON TaskStep[]
  state TEXT NOT NULL,                -- queued | claimed | running | done | failed | cancelled | lost
  env_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,  -- claims so far; a lost task is requeued once
  queued_at TEXT NOT NULL,
  claimed_at TEXT, started_at TEXT, ended_at TEXT,
  heartbeat_at TEXT,
  cancel_requested_at TEXT,
  results TEXT NOT NULL DEFAULT '[]', -- JSON, as reported by the worker
  summary TEXT,                       -- one line, as reported by the worker
  log_bytes INTEGER NOT NULL DEFAULT 0,
  artifact_bytes INTEGER NOT NULL DEFAULT 0,
  patch TEXT,                         -- unified git diff the worker applies to the checkout (at most 1 MiB)
  warm_key TEXT,                      -- build-cache key shared by tasks of one repo
  warm_role TEXT,                     -- use | build
  sandbox_env TEXT                    -- JSON SandboxEnv: image and CI-gate inputs the worker used
);
CREATE INDEX IF NOT EXISTS build_tasks_queue ON build_tasks(priority DESC, id) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS build_tasks_env ON build_tasks(env_id, state);
CREATE INDEX IF NOT EXISTS build_tasks_active ON build_tasks(heartbeat_at) WHERE state IN ('claimed', 'running');
CREATE INDEX IF NOT EXISTS build_tasks_repo ON build_tasks(repo, id);
CREATE INDEX IF NOT EXISTS build_tasks_state ON build_tasks(state, id);
CREATE INDEX IF NOT EXISTS build_tasks_ended ON build_tasks(ended_at);

-- Log chunks as the worker sent them (text, untrusted); capped per task.
CREATE TABLE IF NOT EXISTS build_task_logs (
  task_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  step TEXT NOT NULL,
  chunk TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
) WITHOUT ROWID;

-- Artifact metadata; the bytes are files under the artifact directory.
CREATE TABLE IF NOT EXISTS build_artifacts (
  task_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,         -- from sniffing the bytes, never from the worker's header
  file TEXT NOT NULL,                 -- path under the artifact directory
  PRIMARY KEY (task_id, name)
) WITHOUT ROWID;

-- GitHub writes made after an operator's answer (src/act): one row per decision
-- and item. done: commented and closed; skipped: the item had already closed
-- or its head moved, nothing written; failed: retried by the next run (a
-- comment_url on a failed row means the comment is posted and only the close is left).
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- comment-close
  state TEXT NOT NULL,                -- done | skipped | failed
  comment_url TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (decision_id, repo, number, kind)
);
CREATE INDEX IF NOT EXISTS actions_item ON actions(repo, number);
-- Fix-up tries by the Integrate stage on take-fix PRs, one row per try (or per
-- head for cannot-push and too-large). state: pushed | failed | refused (the
-- patch or a pre-push check said no) | cannot-push | too-large | asked (the fixes
-- were posted as a comment on a PR we can't push to), pushing (written before the push, to_head is the commit about to be
-- pushed; replaced by the push's outcome; one left behind by a crash counts as a try). Only the first
-- three count against the two tries per PR. superseded: a row whose reason no longer applies (kept for the record, ignored).
-- source: NULL = the review's fix list, 'premerge' = the pre-merge review's fix list (one round per PR).
CREATE TABLE IF NOT EXISTS fixups (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  from_head TEXT NOT NULL,            -- the reviewed head commit the fix was made on
  to_head TEXT,                       -- the pushed commit; NULL unless pushed
  state TEXT NOT NULL,
  reason TEXT,                        -- one line, public-safe
  files TEXT,                         -- JSON [path] the fix names (pushed: the files changed)
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fixups_item ON fixups(repo, number, created_at);
-- CI fix tries (src/cifix): one row per try at a head whose gate check failed. kind: format | code | infra.
-- state: infra (waiting for the one rerun) | rerun | formatting (formatter task queued, task_id) | pushed | asked (patch posted as a comment) |
-- linting (a model patch is stored, patch/lint_task/lint_round/lint_state, and waits for its lint task) | failed | refused | rejected | cannot-push | push-denied | pushing (written before the push, to_head is the commit about to be pushed) |
-- skipped (final: nothing to fix here, not a try) | capped (final: the PR's limit of 2 pushed fixes or 4 tries is used; not a try) | rerunning (rerun requested, written before the gh calls) | comment-failed (final: the patch comment failed) | superseded (a row whose reason no longer applies; ignored). Tries are the rows in formatting, pushing, pushed, failed, refused and rejected.
CREATE TABLE IF NOT EXISTS ci_fixes (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head TEXT NOT NULL,                 -- the head commit whose check failed
  to_head TEXT,                       -- the pushed commit; NULL unless pushed
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,                        -- one line, public-safe
  files TEXT,                         -- JSON [path] changed
  attempt INTEGER NOT NULL,
  task_id INTEGER,                    -- build task of a formatter run
  runs TEXT,                          -- JSON [run id] of the failed Actions runs (infra rows: what the rerun targets)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ci_fixes_item ON ci_fixes(repo, number, head);
-- One verification per PR head commit (Verify stage). kind: ci-enough | tests | regression.
-- state: planned (tasks queued) | running | passed | failed | error (the plan was invalid, no task) | ci-enough | stale (the PR moved on) | unavailable (private or non-Rust repo: nothing to build, the Merge? decision says so).
CREATE TABLE IF NOT EXISTS verifications (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,               -- at most 25 words
  plan TEXT,                          -- JSON, the validated plan
  model TEXT,
  head_task_id INTEGER,
  base_task_id INTEGER,
  state TEXT NOT NULL,
  summary TEXT,                       -- why it failed or errored (failed: written by Haiku)
  note TEXT,                          -- on a pass: what the result does not show
  created_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (repo, number, head_sha)
);
CREATE INDEX IF NOT EXISTS verifications_state ON verifications(state);
-- Priority of an open item (Prioritize step). text_hash is the item's embed_hash when the models ran;
-- the models run again only when it changes, while score is recomputed from the mirror on each pass.
-- impact: the priority level, P0 (critical) to P4 (backlog). score: reach 0-99, the tie-breaker inside a level. model: jev (sure) | haiku | jev-unsure (no Haiku answer).
CREATE TABLE IF NOT EXISTS item_priority (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  impact TEXT NOT NULL,
  jev_impact TEXT, jev_p REAL,
  haiku_impact TEXT,
  score INTEGER NOT NULL,
  model TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS item_priority_score ON item_priority(score);
INSERT OR IGNORE INTO stage_limits (step, per_day) VALUES ('prioritize', 3000);
CREATE INDEX IF NOT EXISTS verifications_finished ON verifications(finished_at);

-- Duplicate candidates (Duplicates stage). a < b. A pair is checked once per pair of text hashes
-- (embed_hash of each item); verdict is NULL until a model has answered. jev_p is Jev's yes-probability,
-- haiku the second opinion (duplicate | distinct | unsure) when Jev was not sure either way.
-- canonical is the one to keep. by_operator marks a pair an operator answered "not a duplicate" or "keep both" for.
CREATE TABLE IF NOT EXISTS duplicate_pairs (
  repo TEXT NOT NULL,
  a INTEGER NOT NULL, b INTEGER NOT NULL,
  a_hash TEXT NOT NULL, b_hash TEXT NOT NULL,
  similarity REAL NOT NULL,
  jev_p REAL,
  haiku TEXT,
  verdict TEXT,                       -- duplicate | distinct | unsure
  canonical INTEGER,
  by_operator INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  checked_at TEXT,
  PRIMARY KEY (repo, a, b, a_hash, b_hash)
);
CREATE INDEX IF NOT EXISTS duplicate_pairs_open ON duplicate_pairs(verdict, similarity);
-- The text hash each open item had when its neighbours were last looked up.
CREATE TABLE IF NOT EXISTS duplicate_scans (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  hash TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
-- One attempt to fix an issue (Fix stage), one row per issue. state: retry (a patch is due; round is the last
-- one tried) | testing (head and base tasks queued) | passed (pushed and opened by the next collect) |
-- pr-opened | skipped (triage: not a clear fix; retried only when the issue text changes) | failed.
CREATE TABLE IF NOT EXISTS fix_attempts (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  main_sha TEXT NOT NULL,             -- default branch head the patch is made and tested on
  text_hash TEXT NOT NULL,            -- of the issue title and body when triaged
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  files TEXT,                         -- JSON [path] the patch may edit
  crate TEXT, crate_dir TEXT,
  patch TEXT,                         -- the latest validated patch (fix and test file)
  test_patch TEXT,                    -- the test file alone
  head_task_id INTEGER, base_task_id INTEGER,
  retries INTEGER NOT NULL DEFAULT 0, -- tasks queued again after a build-environment error
  push_tries INTEGER NOT NULL DEFAULT 0,
  summary TEXT,                       -- why the last round failed (public-safe, one line)
  pr_url TEXT,
  reason TEXT,                        -- triage reason, or why it failed
  -- size (S | M | L | XL) is added by migration: the triage's estimate of the fix
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS fix_attempts_state ON fix_attempts(state);
INSERT OR IGNORE INTO stage_limits (step, per_day) VALUES ('fixissue', 10);

-- Work rank of an open item (src/rank): level, type, size and reach in one sortable integer, recomputed
-- by the rank step from stored results, without a model. breakdown is JSON with each part.
CREATE TABLE IF NOT EXISTS item_rank (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  score INTEGER NOT NULL,
  breakdown TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS item_rank_score ON item_rank(score);

-- Opus checks of the patches we write (src/patchcheck): one row per check, before a fix-up is pushed or a fix PR is opened.
-- subject: the commit the patch applies to (the PR head for kind fixup, the default branch head for kind fixissue).
CREATE TABLE IF NOT EXISTS patch_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- fixup | fixissue
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  subject TEXT NOT NULL,
  patch_hash TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,   -- the fix round, or the fix-up try
  verdict TEXT NOT NULL,              -- approve | reject
  reasons TEXT NOT NULL,
  problems TEXT NOT NULL,             -- JSON [text]
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS patch_checks_item ON patch_checks(repo, number, id);

-- Integration batches of the merge queue (src/merge/batch.ts): merge-eligible PRs of one repo landed together through one
-- integration branch and one PR. state: checking (sandbox task running) | open (batch PR open, upstream CI running) |
-- merged | failed (a single PR that failed: on hold) | split (failed with several PRs: two child batches retry the halves) |
-- superseded (main moved or a member changed: a new batch took over).
CREATE TABLE IF NOT EXISTS merge_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,               -- integration-<repo>-<yyyymmdd>-<n>
  state TEXT NOT NULL,
  base_sha TEXT NOT NULL,             -- default branch head the batch was built on
  commit_sha TEXT NOT NULL,           -- head of the integration branch
  parent_id INTEGER,                  -- the batch this one split or replaced
  task_id INTEGER,                    -- sandbox task of the combined tree
  retries INTEGER NOT NULL DEFAULT 0, -- task queued again after a build-environment error
  pr_number INTEGER, pr_url TEXT,
  summary TEXT,                       -- why it failed (public-safe, one line)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  fork TEXT,                          -- <owner>/<repo> the branch was pushed to; null before the push
  merge_sha TEXT                      -- merge commit of the batch PR, when the merge command reported it
);
CREATE INDEX IF NOT EXISTS merge_batches_repo ON merge_batches(repo, state);
CREATE TABLE IF NOT EXISTS merge_batch_prs (
  batch_id INTEGER NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,             -- the PR head merged into the batch
  position INTEGER NOT NULL,
  PRIMARY KEY (batch_id, number)
);
CREATE INDEX IF NOT EXISTS merge_batch_prs_pr ON merge_batch_prs(number, head_oid);

-- Last `claude auth status` of each account: sign-in state, method, plan and
-- the login's end date. Nothing else of the status (no email) is kept.
CREATE TABLE IF NOT EXISTS claude_account_status (
  account_id TEXT PRIMARY KEY,
  logged_in INTEGER NOT NULL,
  method TEXT,
  plan TEXT,
  login_expires_at TEXT,
  checked_at TEXT NOT NULL
);

-- The one pull request review we posted per PR (review-post): its GraphQL node
-- id and the head commit its body describes. A later Opus review at a new head
-- edits this review in place.
CREATE TABLE IF NOT EXISTS review_posts (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  edited_at TEXT,
  PRIMARY KEY (repo, number)
);
INSERT OR IGNORE INTO stage_limits (step, per_day) VALUES ('review-post', 40);

-- Duplicate groups compared in one pass (src/dupes/compare.ts). One row per set of
-- same-kind group members (kind pr | issue), keyed by the sorted numbers. hash covers
-- each member's state, head commit and text hash: a change re-runs the comparison.
-- source: model | closed (a closed or merged member wins without a call) | rule (the
-- model failed; canonical.ts decided) | single. result is the model's JSON per other member.
CREATE TABLE IF NOT EXISTS dupe_comparisons (
  repo TEXT NOT NULL,
  key TEXT NOT NULL,                  -- kind:n1,n2,...
  kind TEXT NOT NULL,                 -- pr | issue
  members TEXT NOT NULL,              -- JSON [numbers]
  hash TEXT NOT NULL,
  kept INTEGER NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  reason TEXT,
  result TEXT,                        -- JSON {others: [...], rounds: n}
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, -- consecutive rule results at this hash; a rule result is tried again after 24 h, three times at most
  at TEXT NOT NULL,
  PRIMARY KEY (repo, key)
);
-- The group decision (kind duplicate, id repo:dupegroup:<lowest member>) and its members.
-- role: keep (one per kind) | close (a duplicate of the keep of its kind: target) | stay (open, not closed).
-- detail is the comparison's JSON for the member (better, carry, adds, duplicate) for the Act step.
-- applied_answer is the answer whose roles were written to dupe_group_items.
CREATE TABLE IF NOT EXISTS dupe_groups (
  decision_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  source TEXT NOT NULL,               -- model | closed | rule
  applied_answer TEXT
);
CREATE TABLE IF NOT EXISTS dupe_group_items (
  decision_id TEXT NOT NULL,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- pr | issue
  role TEXT NOT NULL,
  target INTEGER,
  detail TEXT,
  base_role TEXT NOT NULL,            -- the roles as the comparison gave them; an answer's roles are rebuilt from these
  base_target INTEGER,
  head TEXT,                          -- a PR's head commit and an issue's text hash when the decision was asked; Act skips a member that differs
  PRIMARY KEY (decision_id, number)
);
CREATE INDEX IF NOT EXISTS dupe_group_items_item ON dupe_group_items(repo, number);
-- What the Act step already wrote for a group decision, per member and step (comment | details | close). Written right after each write so a retry never repeats it.
CREATE TABLE IF NOT EXISTS dupe_group_posts (
  decision_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  step TEXT NOT NULL,
  url TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (decision_id, number, step)
);
-- Carry-over of a kept PR's group: parts of the closed PRs to port onto it (Fix-up). queued | done | held.
CREATE TABLE IF NOT EXISTS dupe_carries (
  decision_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,            -- the kept PR
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,                       -- pushed | asked | gone | too-large | failed, with reason
  to_head TEXT,
  from_head TEXT,                     -- the head the pushed commit was made on
  updated_at TEXT NOT NULL,
  PRIMARY KEY (decision_id, number)
);
-- The exact comments each answer of a group decision posts (src/dupes/texts.ts), written when the decision is asked. option: accept | keep:<n>.
CREATE TABLE IF NOT EXISTS dupe_group_texts (
  decision_id TEXT NOT NULL,
  option TEXT NOT NULL,
  number INTEGER NOT NULL,
  step TEXT NOT NULL,                 -- close | details | suggestion
  text TEXT NOT NULL,
  PRIMARY KEY (decision_id, option, number, step)
);
-- Failed writes per member, so one permanent error does not block every later group.
CREATE TABLE IF NOT EXISTS dupe_group_fails (
  decision_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  fails INTEGER NOT NULL,
  PRIMARY KEY (decision_id, number)
);

-- Fast track (src/fasttrack.ts): items an operator moved to the front of every stage that orders work by the work rank.
-- id is the order they were added in; the lowest id runs first. Rows of closed or merged items are ignored, not deleted.
CREATE TABLE IF NOT EXISTS fast_track (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE (repo, number)
);

-- Merge holds (src/merge/controls.ts): a PR held here is reviewed and fixed as usual but does not merge, alone or in a batch, until released.
CREATE TABLE IF NOT EXISTS merge_holds (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  held_by TEXT NOT NULL,
  held_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
-- Conversations with Opus: one per item, shown to everyone with access to the repo (src/conversations).
-- item_block is written once, when the conversation starts, and sent byte for byte on every turn so the prompt's start stays cached.
CREATE TABLE IF NOT EXISTS conversations (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  item_block TEXT NOT NULL,
  item_sig TEXT NOT NULL,             -- hash of the item's head commit and text as the block (or the last update turn) described them
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,           -- operator login, or 'opus' when a recommendation started it
  PRIMARY KEY (repo, number)
);
-- Turns in prompt order (seq order). block is the exact text the prompt carries for the turn, written with the turn.
-- An operator turn waits for its reply while status is 'pending' (queued) or 'answering' (a run claimed it); there is at most one
-- per conversation, and it has no seq until it is answered or failed. A system turn that arrives while a run answers is 'held'
-- (no seq) and takes the next seq after the reply, so the prompt the run sent stays a prefix of the next one.
CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- operator | opus | system
  login TEXT NOT NULL,                -- operator login, 'opus' or 'system'
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  block TEXT NOT NULL,
  status TEXT,                        -- operator turns: pending | answering | answered | failed; system turns: held | NULL
  error TEXT,
  notes TEXT,                         -- opus turns: JSON array of notes about dropped cards
  seq INTEGER,                        -- position in the prompt; NULL while pending, answering or held
  claim TEXT,                         -- answering: token of the run that holds the message
  claimed_at TEXT,
  progress TEXT                       -- answering: JSON array of the last few progress lines, newest last
);
CREATE INDEX IF NOT EXISTS conversation_turns_item ON conversation_turns(repo, number, id);
CREATE INDEX IF NOT EXISTS conversation_turns_at ON conversation_turns(at);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_waiting ON conversation_turns(repo, number) WHERE status IN ('pending', 'answering');
-- Action cards Opus proposed on a turn. params are the exact parameters; text is the editable comment of a comment card.
CREATE TABLE IF NOT EXISTS conversation_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- comment | answer | label | backlog | duplicate
  params TEXT NOT NULL,               -- JSON
  text TEXT,
  description TEXT NOT NULL,          -- one plain line written by our code from the parameters
  state TEXT NOT NULL DEFAULT 'proposed',  -- proposed | running | done | failed | dismissed
  result TEXT,                        -- what happened, in one line
  result_url TEXT,
  error TEXT,
  acted_by TEXT,
  acted_at TEXT,
  edited_by TEXT,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS conversation_cards_turn ON conversation_cards(turn_id);
CREATE INDEX IF NOT EXISTS conversation_cards_item ON conversation_cards(repo, number);

-- A repo's area list, one row per saved version; the current version is the highest.
CREATE TABLE IF NOT EXISTS area_lists (
  repo TEXT NOT NULL,
  version INTEGER NOT NULL,
  areas TEXT NOT NULL,                -- JSON [{name, description}]
  at TEXT NOT NULL,
  by TEXT,                            -- operator login, or NULL for a CLI save
  note TEXT,                          -- what the save did, one line
  PRIMARY KEY (repo, version)
);

-- The area of each item. area NULL with a list_version means "none of these" was the answer for that version.
-- A row whose area survived a list change moves to the new version; a NULL row stays on the version it was asked against.
CREATE TABLE IF NOT EXISTS item_areas (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  area TEXT,
  source TEXT NOT NULL,               -- jev | haiku | operator
  confidence REAL,                    -- Jev's top probability, else NULL
  list_version INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX IF NOT EXISTS item_areas_area ON item_areas(repo, area);

-- Area lists proposed by a model, waiting for the operator. kind 'propose' is a whole list; 'suggest' is areas to add.
CREATE TABLE IF NOT EXISTS area_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- propose | suggest
  areas TEXT NOT NULL,                -- JSON [{name, description, state}] with state open | accepted | ignored
  created_at TEXT NOT NULL,
  created_by TEXT,
  state TEXT NOT NULL DEFAULT 'open', -- open | accepted | dismissed (a suggest closes once every area is decided)
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS area_proposals_repo ON area_proposals(repo, state);

-- Actions runs waiting for a maintainer's approval (check suite conclusion action_required) at a PR head, one row per PR
-- (src/merge/ci-approval.ts). runs: JSON [{id, name, event}] still waiting; approved: ids of runs we approved whose
-- suites have not finished yet; reread: a refused merge said runs wait, the step reads them; failed: JSON {runId: failed
-- approvals}; cross_repo: the PR comes from a fork.
CREATE TABLE IF NOT EXISTS ci_run_approvals (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  cross_repo INTEGER NOT NULL DEFAULT 0,
  runs TEXT NOT NULL,
  approved TEXT NOT NULL,
  reread INTEGER NOT NULL DEFAULT 0,
  failed TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  approved_at TEXT,
  PRIMARY KEY (repo, number)
);

-- Merges of the default branch into conflicted take / take-fix PRs by the Fix-up step (src/fixup/conflict.ts), one row per try (or
-- per head for asked). state: merged (pushed) | failed | refused (validation said no) | rejected (the Opus check said no) | asked
-- (a comment asked the contributor to merge or rebase), superseded (a skip or refusal under limits since replaced; neither held nor a try), pushing (written before the push, to_head is the merge commit about to be pushed). merged, pushing, failed, refused and rejected are tries; two per head.
CREATE TABLE IF NOT EXISTS conflict_merges (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  from_head TEXT NOT NULL,            -- the PR head the base was merged into
  to_head TEXT,                       -- the pushed merge commit; NULL unless merged
  base_sha TEXT,                      -- the base branch commit merged in
  state TEXT NOT NULL,
  reason TEXT,                        -- one line, public-safe
  files TEXT,                         -- JSON [path] the resolver resolved ([] for a clean merge)
  -- state linting: patch (JSON [{path, mode, content}], the resolved files), lint_task and lint_round (1 = first resolution) wait for the lint task of the resolution
  attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conflict_merges_item ON conflict_merges(repo, number, created_at);

-- Post-merge review (src/postmerge): one Opus review of what a pipeline merge landed, latest per PR.
-- findings: JSON array of the validated findings; error: why no review was stored (retry: ... is tried again after an hour).
-- merge_sha: the commit the review read (the merge commit, else the PR's last head).
CREATE TABLE IF NOT EXISTS postmerge_reviews (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  merge_sha TEXT NOT NULL,
  at TEXT NOT NULL,
  model TEXT,
  run_id TEXT,
  findings TEXT,
  error TEXT,
  tries INTEGER NOT NULL DEFAULT 0,   -- consecutive reviews that ended in a retry: error; the third becomes held
  PRIMARY KEY (repo, number)
);
-- What the filing step did with each finding of a review (review_at identifies the review).
-- state: filing (written before gh issue create runs; one left in this state has an unknown outcome and is never retried) | filed |
-- failed (gh refused with no possible side effect; attempts counts the tries, retried after 1 h and then 6 h, three at most) |
-- skipped-duplicate (duplicate_of: the PR or issue number that covers it) | skipped-limit | skipped-minor | skipped-stale (the cited file is gone).
-- A skipped-limit row is replaced when the finding is filed later.
CREATE TABLE IF NOT EXISTS postmerge_followups (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  review_at TEXT NOT NULL,
  finding INTEGER NOT NULL,
  title TEXT NOT NULL,
  issue_number INTEGER,
  url TEXT,
  state TEXT NOT NULL,
  at TEXT NOT NULL,
  duplicate_of INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  note TEXT,                          -- one line: why a failed attempt failed
  PRIMARY KEY (repo, number, review_at, finding)
);
CREATE INDEX IF NOT EXISTS postmerge_followups_issue ON postmerge_followups(repo, issue_number);
-- Only merges from this moment on are reviewed unless `postmerge backfill` moves it back.
INSERT OR IGNORE INTO settings (key, value) VALUES ('postmerge_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- CI on the default branch of every synced repo, one row per head commit seen. Written by the main-ci step.
-- state: green | red | optional | running | none (src/mainci/classify.ts).
CREATE TABLE IF NOT EXISTS main_ci (
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL,
  failing TEXT NOT NULL,              -- JSON [{name, url}]: the checks that failed
  checks TEXT NOT NULL,               -- JSON [{name, state, url}]; state: success | failure | pending | skipped
  committed_at TEXT,
  headline TEXT,                      -- first line of the commit message
  first_seen_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, head_sha)
);
CREATE INDEX IF NOT EXISTS main_ci_repo_time ON main_ci(repo, committed_at);

-- Red default branches (src/mainfix): one row per (repo, head, failing gate check), written once the check is sorted.
-- verdict: flaky | infra | code (Haiku, from the failed step's log).
-- state: rerun-requested (flaky: the failed jobs were rerun, written before the call) | rerun-passed (the head turned green) |
--   asked (infra: an operator decision asks whether to open an issue) | issue-opened | declined (infra: the answers to that decision) |
--   needs-fix (code, or red again after a rerun: waits for the fix PR step) | nothing-to-do (nothing readable to act on, or main is
--   green again, or an open PR already covers the failure: `#N` in the reason) | pr-opened (our fix PR: pr_number, pr_url) |
--   fix-failed (no fix PR could be made: reason; a person takes over). One attempt per row.
CREATE TABLE IF NOT EXISTS main_fixes (
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  "check" TEXT NOT NULL,
  verdict TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,                        -- one line, public-safe
  run_id INTEGER,                     -- the failed Actions run
  run_url TEXT,
  excerpt TEXT,                       -- scrubbed tail of the failed step's log
  decision_id TEXT,
  issue_number INTEGER,
  pr_number INTEGER,                  -- the fix PR
  pr_url TEXT,
  -- state linting: the one model patch of the head's rows (patch, files JSON, lint_task, lint_round, lint_state pending | requeued) waits for its lint task
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, head_sha, "check")
);

-- Pre-merge review (src/premerge): one adversarial review per PR head the rule would merge.
-- findings: JSON PremergeFinding[] once a review is stored (NULL until then); error: why the last try stored none
-- (retried after 1 h, the third failed try makes the head failed); searched: what the reviewer looked at.
CREATE TABLE IF NOT EXISTS premerge_reviews (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  at TEXT NOT NULL,
  run_id TEXT,
  model TEXT,
  findings TEXT,
  searched TEXT,
  error TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, number, head_oid)
);

-- What operators said once, kept so reviews of related work see it (src/memory/). One row per source: the answer note of a
-- decision, a comment (or review) of an operator on GitHub that AutoCraft did not post, or an operator's message in a conversation.
-- source_id is the decision id, the comment's node id or the turn's id. embedding: float32 unit vector of the item title and the text, by `model`.
CREATE TABLE IF NOT EXISTS owner_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,          -- decision-note | comment | conversation
  source_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER,
  item_title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  embedding BLOB,
  model TEXT,
  UNIQUE (source_kind, source_id)
);

-- The planner's output (src/core/plan-cache.ts): what is due for each item at the end of the last planner pass. One row per
-- PR or item; written by the planner only, in one transaction, only the rows that changed. For a PR, `state` is the state of
-- its review-to-merge Plan and `item_state` that of its triage plan; for an issue `state` is the triage state. `actions` is JSON
-- [{kind, head, params?}] in priority order, triage actions first; `reasons` is JSON string[] (why it is outside the merge rule).
CREATE TABLE IF NOT EXISTS item_plans (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- pr | issue
  head TEXT,
  state TEXT NOT NULL,
  item_state TEXT,
  actions TEXT NOT NULL,
  wait TEXT,
  reasons TEXT NOT NULL,
  note TEXT,
  view TEXT NOT NULL DEFAULT '{}',    -- JSON for the dashboard (PlanView in src/core/plan-cache.ts): next-step text, scope, label, queue fields
  planned_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;

-- What each autopilot lane's next jobs take, as the last planner pass listed it (LaneItem[] as JSON, capped); the Next page reads it.
CREATE TABLE IF NOT EXISTS lane_next (
  lane TEXT PRIMARY KEY,
  total INTEGER NOT NULL,
  items TEXT NOT NULL,
  at TEXT NOT NULL
) WITHOUT ROWID;

-- One row per run of the build tool by a patch-writing model (src/checktool): the command, its outcome in one line, and the worker task that ran it.
CREATE TABLE IF NOT EXISTS model_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,                     -- the agent run (model call) that made it
  step TEXT NOT NULL,                 -- fixup | cifix | fixissue
  repo TEXT NOT NULL,
  number INTEGER,
  head TEXT NOT NULL,
  command TEXT NOT NULL,              -- fmt | clippy | check | test
  crate TEXT,
  test_name TEXT,
  task_id INTEGER,
  outcome TEXT,                       -- null while running; e.g. "0 findings", "exit 101", "refused: ..."
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS model_checks_item ON model_checks(repo, number, id);

-- Every push of ours to a PR branch (fix-up, conflict merge, CI fix, fix-issue PR) and what it did to the PR's required checks.
-- before_res / after_res: green | red | pending | none | unknown (required checks only; optional ones are ignored). A branch created
-- by the push has no earlier head: it counts as green before. outcome stays NULL until the checks at to_oid are final;
-- then kept-green | fixed | broke | still-red | unknown. number is NULL for a fix-issue push until its PR's checks arrive.
-- stage: fixup | cifix | fixissue (the circuit breaker's stage); action: the audit action of the push.
CREATE TABLE IF NOT EXISTS push_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  stage TEXT NOT NULL,
  action TEXT NOT NULL,
  repo TEXT NOT NULL, number INTEGER,
  from_oid TEXT, to_oid TEXT NOT NULL,
  before_res TEXT NOT NULL,
  after_res TEXT,
  outcome TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS push_outcomes_to ON push_outcomes(repo, to_oid);
CREATE INDEX IF NOT EXISTS push_outcomes_stage ON push_outcomes(stage, id);

-- Circuit breaker: a stage that stopped itself. One row per stage; active = 1 while tripped, and only an operator clears it
-- (autocraft pipeline resume <stage>, or the Resume button on the Pipeline page). Pushes and merges from before cleared_at
-- do not count towards the next trip. evidence: JSON of refs (repo#number and commits).
CREATE TABLE IF NOT EXISTS stage_trips (
  stage TEXT PRIMARY KEY,             -- fixup | cifix | fixissue | merge
  active INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  tripped_at TEXT NOT NULL,
  cleared_at TEXT, cleared_by TEXT
);

-- Item links: records that attach to a GitHub item. plan_history gets a row each time the planner (src/core/plan-cache.ts)
-- stores a different state or wait for an item (old_state is NULL for the first plan seen); job_items lists the items a job
-- handled (src/runner/job-items.ts), with a one-line outcome. Both are pruned with the jobs (90 days).
CREATE TABLE IF NOT EXISTS plan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head TEXT,
  old_state TEXT, new_state TEXT NOT NULL,   -- new_state is 'gone' when the item left the plan set
  old_wait TEXT, wait TEXT,
  reasons TEXT NOT NULL,              -- JSON string[], as in item_plans
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_history_item ON plan_history(repo, number, id);
CREATE INDEX IF NOT EXISTS plan_history_at ON plan_history(at);
CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  outcome TEXT,                       -- one line
  at TEXT NOT NULL,
  ref TEXT                            -- the decision the job asked about the item, when it asked one
);
CREATE INDEX IF NOT EXISTS job_items_item ON job_items(repo, number, id);
CREATE INDEX IF NOT EXISTS job_items_job ON job_items(job_id, id);

-- The item trace (src/dash/api/trace.ts) reads every table by (repo, number); these had no index for it.
CREATE INDEX IF NOT EXISTS agent_run_items_item ON agent_run_items(repo, number, run_id);
CREATE INDEX IF NOT EXISTS build_tasks_item ON build_tasks(repo, number, id);
CREATE INDEX IF NOT EXISTS decisions_item ON decisions(repo, number);
CREATE INDEX IF NOT EXISTS push_outcomes_item ON push_outcomes(repo, number);

-- Per-item GitHub detail the item list sync does not carry (src/activity.ts): the changed files of a PR's head, its commits, and its label
-- and force-push timeline events. activity_sync records the head and update time each item was last read at.
CREATE TABLE IF NOT EXISTS pr_files (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head TEXT NOT NULL,
  path TEXT NOT NULL,
  additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
  change_type TEXT NOT NULL,          -- ADDED | MODIFIED | DELETED | RENAMED | COPIED | CHANGED
  PRIMARY KEY (repo, number, head, path)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pr_commits (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  oid TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  author TEXT,                        -- GitHub login; null when the commit email maps to no account
  first_seen_at TEXT,                 -- when the sync first read the commit; committed_at is author-controlled and is clamped to it
  PRIMARY KEY (repo, number, oid)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS item_activity (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  id TEXT NOT NULL,                   -- GraphQL node id of the timeline event
  kind TEXT NOT NULL,                 -- labeled | unlabeled | force-push
  at TEXT NOT NULL,
  actor TEXT,
  label TEXT,                         -- labeled and unlabeled
  before_oid TEXT, after_oid TEXT,    -- force-push
  PRIMARY KEY (repo, number, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS activity_sync (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head TEXT,
  updated_at TEXT,
  read_at TEXT NOT NULL,
  error TEXT,                         -- the last failed read; the item is read again at retry_at
  retry_at TEXT,
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;

-- The items a batch decision (number IS NULL) names in its `items` JSON, so the trace finds them by (repo, number).
-- Filled by the triggers below and once for older rows (src/db.ts: buildDecisionItems).
CREATE TABLE IF NOT EXISTS decision_items (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  decision_id TEXT NOT NULL,
  PRIMARY KEY (repo, number, decision_id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS decision_items_ins AFTER INSERT ON decisions WHEN new.number IS NULL AND json_valid(new.items) AND json_type(new.items) = 'array' BEGIN
  INSERT OR IGNORE INTO decision_items (repo, number, decision_id)
    SELECT json_extract(j.value, '$.repo'), json_extract(j.value, '$.number'), new.id FROM json_each(new.items) j
    WHERE typeof(json_extract(j.value, '$.repo')) = 'text' AND typeof(json_extract(j.value, '$.number')) = 'integer';
END;
-- Dropped first: IF NOT EXISTS keeps an older definition of a trigger whose body changed.
DROP TRIGGER IF EXISTS decision_items_upd;
CREATE TRIGGER decision_items_upd AFTER UPDATE ON decisions WHEN old.items IS NOT new.items OR old.number IS NOT new.number BEGIN
  DELETE FROM decision_items WHERE decision_id = new.id;
  INSERT OR IGNORE INTO decision_items (repo, number, decision_id)
    SELECT json_extract(j.value, '$.repo'), json_extract(j.value, '$.number'), new.id FROM json_each(CASE WHEN new.number IS NULL AND json_valid(new.items) AND json_type(new.items) = 'array' THEN new.items ELSE '[]' END) j
    WHERE typeof(json_extract(j.value, '$.repo')) = 'text' AND typeof(json_extract(j.value, '$.number')) = 'integer';
END;
CREATE TRIGGER IF NOT EXISTS decision_items_del AFTER DELETE ON decisions BEGIN
  DELETE FROM decision_items WHERE decision_id = old.id;
END;

-- The activity stream reads each source's newest rows by time (src/dash/api/activity.ts).
CREATE INDEX IF NOT EXISTS items_merged ON items(merged_at) WHERE merged_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS item_activity_at ON item_activity(at);
CREATE INDEX IF NOT EXISTS stages_at ON stages(at);
CREATE INDEX IF NOT EXISTS job_items_at ON job_items(at);
CREATE INDEX IF NOT EXISTS model_checks_started ON model_checks(started_at);
CREATE INDEX IF NOT EXISTS build_tasks_queued ON build_tasks(queued_at);
CREATE INDEX IF NOT EXISTS push_outcomes_at ON push_outcomes(at);
CREATE INDEX IF NOT EXISTS patch_checks_created ON patch_checks(created_at);
CREATE INDEX IF NOT EXISTS opus_review_history_at ON opus_review_history(at);
CREATE INDEX IF NOT EXISTS premerge_reviews_at ON premerge_reviews(at);
CREATE INDEX IF NOT EXISTS postmerge_reviews_at ON postmerge_reviews(at);
CREATE INDEX IF NOT EXISTS verifications_created ON verifications(created_at);
CREATE INDEX IF NOT EXISTS fixups_created ON fixups(created_at);
CREATE INDEX IF NOT EXISTS ci_fixes_created ON ci_fixes(created_at);
CREATE INDEX IF NOT EXISTS conflict_merges_created ON conflict_merges(created_at);
CREATE INDEX IF NOT EXISTS merges_at ON merges(at);
CREATE INDEX IF NOT EXISTS actions_created ON actions(created_at);
CREATE INDEX IF NOT EXISTS conversation_turns_at ON conversation_turns(at);
CREATE INDEX IF NOT EXISTS decisions_asked_at ON decisions(asked_at);
CREATE INDEX IF NOT EXISTS decision_comments_at ON decision_comments(at);
