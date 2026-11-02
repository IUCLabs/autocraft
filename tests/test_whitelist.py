import tempfile
import unittest
from pathlib import Path

from craft_auto import whitelist
from craft_auto.db import connect


def pr(conn, n, author, state):
    conn.execute("INSERT INTO items (repo, number, kind, state, author, merged_at) VALUES ('r', ?, 'pr', ?, ?, ?)",
                 (n, state, author, "2026-01-01" if state == "MERGED" else None))


class WhitelistTest(unittest.TestCase):
    def test_tier_and_override(self):
        conn = connect(Path(tempfile.mkdtemp()) / "t.db")
        n = 0
        for login, merged, closed in [("good", 5, 1), ("lowrate", 5, 5), ("few", 4, 0)]:
            for state, count in (("MERGED", merged), ("CLOSED", closed)):
                for _ in range(count):
                    n += 1
                    pr(conn, n, login, state)
        self.assertTrue(whitelist.is_whitelisted(conn, "good")[0])
        self.assertFalse(whitelist.is_whitelisted(conn, "lowrate")[0])
        self.assertFalse(whitelist.is_whitelisted(conn, "few")[0])
        self.assertFalse(whitelist.is_whitelisted(conn, "nobody")[0])
        whitelist.set_override(conn, "good", "deny")
        whitelist.set_override(conn, "few", "allow")
        whitelist.set_override(conn, "nobody", "allow")
        self.assertFalse(whitelist.is_whitelisted(conn, "good")[0])
        self.assertTrue(whitelist.is_whitelisted(conn, "few")[0])
        self.assertTrue(whitelist.is_whitelisted(conn, "nobody")[0])
        whitelist.set_override(conn, "good", None)
        self.assertTrue(whitelist.is_whitelisted(conn, "good")[0])


if __name__ == "__main__":
    unittest.main()
