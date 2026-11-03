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
  action TEXT NOT NULL,               -- answer | undo | adopt | opinion | opinion-retract | comment | override | rule | access-add | access-remove | access-role | session-revoke | sign-in | sign-in-refused (at most one row per login per hour; details.refused counts them) | repo-track | repo-untrack | labels-approve | labels-revoke | merge-approve | merge-revoke | labels-apply | assign | merge | merge-refused | comment-approve | comment-revoke | review-post | review-edit | act-comment | act-close | act-skip | job-request | job-cancel | pipeline-switch | stage-limit | env-create | env-change | env-rotate-key | task-cancel | unassign | batch-again
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
-- The newest verdict of a classifier (latestRun, latestJevRun) without reading every row.
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
  ('review-batch', 40), ('labels-apply', NULL), ('merge', 10), ('act', 20), ('fixup', 20), ('verify', 30), ('opus-review', 40);

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

-- The second review pass: Opus reads every PR Sonnet rated take or take-fix,
-- one row per PR head commit. A row with `mode = 'skipped'` has no verdict: the
-- rule-based skip list (src/review/skip.ts) exempted the diff from the pass.
CREATE TABLE IF NOT EXISTS opus_reviews (
  repo TEXT NOT NULL, number INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  run_id TEXT,
  at TEXT NOT NULL,
  model TEXT,                         -- NULL when skipped
  mode TEXT NOT NULL,                 -- full | delta | skipped
  base_head TEXT,                     -- delta: the head Opus had reviewed before
  verdict TEXT,                       -- take | take-fix | hold | close; NULL when skipped
  sure INTEGER,                       -- 1 when Opus is sure of its verdict
  reason TEXT,
  fixes TEXT,                         -- JSON [{file, change}], the complete list for take-fix
  risks TEXT,                         -- JSON [string]
  skip_reason TEXT,                   -- mode = 'skipped' only
  -- public_review (added column): JSON {summary, points}, the text posted on the PR; NULL when the reply had none
  PRIMARY KEY (repo, number, head_oid)
);

-- The verdict every later stage reads, per reviewed head commit. Opus's replaces
-- Sonnet's, except that Opus disagreeing with Sonnet while unsure makes a hold for
-- a person (take and take-fix count as agreeing). A skip-listed head keeps Sonnet's
-- verdict. `final` is 0 while a Sonnet take or take-fix still waits for Opus; Sonnet
-- hold and close verdicts are final at once.
CREATE VIEW IF NOT EXISTS final_reviews AS
SELECT r.repo, r.number, r.head_oid, r.run_id, r.at, r.model, r.size, r.duplicate_of, r.overlaps,
  r.verdict AS sonnet_verdict, r.reason AS sonnet_reason, r.fixes AS sonnet_fixes,
  CASE WHEN o.verdict IS NULL THEN r.verdict
    WHEN o.sure = 0 AND replace(o.verdict, 'take-fix', 'take') <> replace(r.verdict, 'take-fix', 'take') THEN 'hold'
    ELSE o.verdict END AS verdict,
  CASE WHEN o.verdict IS NULL THEN r.reason
    WHEN o.sure = 0 AND replace(o.verdict, 'take-fix', 'take') <> replace(r.verdict, 'take-fix', 'take')
      THEN 'Needs a person: Opus is unsure and disagrees with Sonnet. Sonnet (' || r.verdict || '): ' || r.reason || ' Opus (' || o.verdict || '): ' || o.reason
    ELSE o.reason END AS reason,
  CASE WHEN o.verdict IS NULL THEN r.fixes
    WHEN o.sure = 0 AND replace(o.verdict, 'take-fix', 'take') <> replace(r.verdict, 'take-fix', 'take') THEN NULL
    ELSE o.fixes END AS fixes,
  CASE WHEN o.verdict IS NULL THEN r.risks ELSE o.risks END AS risks,
  CASE WHEN o.verdict IS NOT NULL THEN 'opus' WHEN o.mode = 'skipped' THEN 'skip-list' ELSE 'sonnet' END AS source,
  o.skip_reason AS skip_reason,
  CASE WHEN r.verdict IN ('hold', 'close') OR o.head_oid IS NOT NULL THEN 1 ELSE 0 END AS final
FROM reviews r LEFT JOIN opus_reviews o ON o.repo = r.repo AND o.number = r.number AND o.head_oid = r.head_oid;

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
-- Written by `craft-auto embed` (src/embed/); the dashboard only reads them.
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
-- were posted as a comment on a PR we can't push to). Only the first
-- three count against the two tries per PR.
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
  fork TEXT                           -- <owner>/<repo> the branch was pushed to; null before the push
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
