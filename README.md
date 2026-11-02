# craft-automation

Local mirror of every storytold issue and PR, the triage pipeline's state, and the backlog dashboard.

- `craft-auto sync` fills a SQLite mirror (`~/.local/share/craft-automation/mirror.db`, or `$CRAFT_AUTO_DB`) from GitHub GraphQL. Agents and scripts query the mirror instead of calling `gh`.
- `craft-auto whitelist` shows and edits which contributors' PRs may merge on green CI without a decision.
- `craft-auto dash serve` serves the dashboard.

Schema: `craft_auto/schema.sql`. Mirror tables are overwritten by sync; work tables (classifications, stages, whitelist overrides, token use) are ours.
