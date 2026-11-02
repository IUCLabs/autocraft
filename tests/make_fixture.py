"""Fill a scratch DB with fake rows in every table: `uv run python tests/make_fixture.py [DB]`."""
import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from craft_auto.db import connect

REPOS = ["photocraft", "designcraft", "pdfcraft", "craft-libs"]
AUTHORS = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy", "mallory"]
TYPES = ["bugfix", "performance", "missing feature", "small extra", "plugin candidate", "infra"]
AREAS = ["export", "canvas", "filters", "ui", "build", "i18n"]
QUESTIONS = ["Is this feature in scope for the reference app?", "Close enough to the reference behaviour?",
             "Plugin or core?", "Keep both approaches or pick one?", "Adds a setting: wanted?"]


def main(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    conn = connect(path)
    rnd = random.Random(7)
    now = datetime.now(timezone.utc)
    iso = lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    for r in REPOS:
        conn.execute("INSERT INTO repos VALUES (?,?,?,?,?,?,?)", (r, "public", "main", 0, 0, iso(now), iso(now)))
    for n in range(1, 401):
        repo = rnd.choice(REPOS)
        kind = "pr" if rnd.random() < 0.6 else "issue"
        if kind == "pr":
            state = rnd.choices(["OPEN", "MERGED", "CLOSED"], [5, 3, 2])[0]
        else:
            state = rnd.choices(["OPEN", "CLOSED"], [7, 3])[0]
        created = now - timedelta(days=rnd.randint(1, 400))
        merged = min(now, created + timedelta(days=rnd.randint(0, 20))) if state == "MERGED" else None
        add, dele = (int(rnd.lognormvariate(4, 1.5)), int(rnd.lognormvariate(3, 1.5))) if kind == "pr" else (None, None)
        sub = "pull" if kind == "pr" else "issues"
        conn.execute(
            "INSERT INTO items (repo, number, kind, state, title, url, author, created_at, updated_at, merged_at, "
            "labels, assignees, additions, deletions, changed_files, ci_state, mergeable, detail_level) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,'[]','[]',?,?,?,?,?,?)",
            (repo, n, kind, state, f"{rnd.choice(['Fix', 'Add', 'Speed up', 'Refactor'])} {rnd.choice(AREAS)} {rnd.choice(['crash', 'option', 'preview', 'cache'])}",
             f"https://github.com/storytold/{repo}/{sub}/{n}", rnd.choice(AUTHORS), iso(created), iso(created),
             iso(merged) if merged else None, add, dele, rnd.randint(1, 20) if kind == "pr" else None,
             rnd.choice(["SUCCESS", "FAILURE", "PENDING"]), rnd.choice(["MERGEABLE", "CONFLICTING"]), "full"))
        if state != "OPEN":
            continue
        if rnd.random() < 0.8:
            conn.execute("INSERT INTO classifications VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         (repo, n, "haiku", "run1", iso(now - timedelta(hours=rnd.randint(1, 30))), rnd.choice(TYPES),
                          rnd.choice(["yes", "no", "unclear"]), "Reference app has this in Preferences" if rnd.random() < .5 else None,
                          "1", "[]", None, rnd.choice(AREAS), "Touches one module; behaviour matches an open reference issue."))
        stages = ["classified", "reviewed", rnd.choice(["take", "hold", "close", "needs-decision", "needs-decision"])]
        if stages[-1] == "take" and rnd.random() < .5:
            stages.append("batched")
        for i, st in enumerate(stages[: rnd.randint(1, len(stages))]):
            at = now - timedelta(hours=rnd.randint(0, 40), minutes=i)
            conn.execute("INSERT INTO stages VALUES (?,?,?,?,?,?,?)",
                         (repo, n, st, iso(at), "sonnet-review",
                          rnd.choice(QUESTIONS) if st == "needs-decision" else None,
                          f"{repo[:3].upper()}-{n}" if st == "needs-decision" and rnd.random() < .3 else None))
    for n in range(401, 421):
        repo = rnd.choice(REPOS)
        conn.execute("INSERT INTO stages VALUES (?,?,?,?,?,?,?)", (repo, n, "merged", iso(now - timedelta(hours=rnd.randint(0, 20))), "merger", None, None))
    for login, st, note in [("mallory", "deny", "private: spammy history"), ("judy", "allow", "private: known maintainer")]:
        conn.execute("INSERT INTO whitelist_overrides VALUES (?,?,?,?,?)", (login, st, note, "owner", iso(now)))
    for i, (stage, model, per_item) in enumerate([("classify", "haiku", 900), ("classify", "jev", 0), ("review", "sonnet", 24000), ("fix", "opus", 60000)]):
        for j, repo in enumerate(REPOS):
            items = rnd.randint(20, 120)
            conn.execute("INSERT INTO token_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                         (f"run{i}{j}", f"{stage}-{j}", stage, model, repo, items, items * per_item, items * per_item // 10,
                          items * per_item * 3, items * per_item // 5, iso(now - timedelta(hours=2)), iso(now)))
    conn.commit()
    print(f"fixture written to {path}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ["CRAFT_AUTO_DB"]))
