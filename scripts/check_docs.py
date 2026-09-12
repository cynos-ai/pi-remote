"""Validate this documentation handoff, not the future application.

Uses only Python's standard library. No model calls or network requests.
"""

from __future__ import annotations

import json
import re
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def check_markdown() -> int:
    files = sorted(ROOT.glob("*.md")) + sorted((ROOT / "docs").rglob("*.md"))
    for path in files:
        content = path.read_text(encoding="utf-8")
        require("\ufffd" not in content, f"Invalid text in {path.name}")
        require(len(re.findall(r"^\s*```", content, re.M)) % 2 == 0,
                f"Unbalanced code fences: {path.name}")
        require(not re.search(r"[ \t]+$", content, re.M), f"Trailing spaces: {path.name}")
        for match in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", content):
            target = match.group(1).strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith("#"):
                continue
            destination = (path.parent / unquote(parsed.path)).resolve()
            require(destination.is_relative_to(ROOT), f"Link escapes repository: {target}")
            require(destination.exists(), f"Missing link in {path.name}: {target}")
        for block in re.findall(r"```json\s*\n(.*?)\n```", content, re.S):
            json.loads(block)
    return len(files)


def check_traceability() -> None:
    design = (ROOT / "docs/v1-design.md").read_text(encoding="utf-8")
    plan = (ROOT / "docs/development-plan.md").read_text(encoding="utf-8")
    acceptance = (ROOT / "docs/acceptance.md").read_text(encoding="utf-8")
    progress = (ROOT / "docs/progress.md").read_text(encoding="utf-8")
    stages = [f"S{i:02d}" for i in range(1, 14)]
    checks = {f"AT{i:02d}" for i in range(1, 31)}
    requirements = {f"FR{i:02d}" for i in range(1, 13)}
    require(re.findall(r"^## (S\d{2})\b", plan, re.M) == stages, "Stage headings differ")
    require(set(re.findall(r"^\| (FR\d{2}) \|", design, re.M)) == requirements,
            "Product requirements differ")
    rows = re.findall(r"^\| (S\d{2}) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$", plan, re.M)
    require([row[0] for row in rows] == stages, "Plan index differs")
    deps = {stage: re.findall(r"S\d{2}", dependency) for stage, dependency, _, _ in rows}
    for stage, dependency in deps.items():
        require(all(dep in stages and stages.index(dep) < stages.index(stage) for dep in dependency),
                f"Invalid dependency at {stage}")
    require(set(re.findall(r"\bAT\d{2}\b", plan)) == checks, "Plan/check mapping differs")
    at_rows = re.findall(r"^\| (AT\d{2}) \| ([^|]+) \| ([^|]+) \|", acceptance, re.M)
    require(len(at_rows) == 30 and {row[0] for row in at_rows} == checks, "Acceptance IDs differ")
    require(set(re.findall(r"\bFR\d{2}\b", acceptance)) == requirements, "Requirement coverage differs")
    for check, frs, owners in at_rows:
        require(set(re.findall(r"FR\d{2}", frs)) <= requirements, f"Unknown FR at {check}")
        require(set(re.findall(r"S\d{2}", owners)) <= set(stages), f"Unknown stage at {check}")
    progress_rows = re.findall(r"^\| (S\d{2}) \| ([a-z_]+) \|", progress, re.M)
    require([row[0] for row in progress_rows] == stages, "Progress table differs")
    require(all(status in {"not_started", "in_progress", "passed", "blocked"}
                for _, status in progress_rows), "Unknown progress state")
    for stage in stages:
        require(f"pnpm verify:{stage}" in plan, f"Missing verification entry: {stage}")


def check_fixture() -> None:
    fixture = json.loads((ROOT / "docs/examples/stream.json").read_text(encoding="utf-8"))
    events = fixture["events"]
    require([e["seq"] for e in events] == list(range(1, len(events) + 1)), "Event sequence gap")
    protocol = (ROOT / "docs/protocol-v1.md").read_text(encoding="utf-8")
    event_types = set(re.findall(r"^\| ([a-z_]+\.[a-z_]+) \|", protocol, re.M))
    require(all(e["type"] in event_types for e in events), "Undocumented fixture event")
    updates = [e["payload"]["output"]["text"] for e in events if e["type"] == "tool.updated"]
    require(len(updates) >= 2 and updates[1].startswith(updates[0]), "Missing cumulative output example")
    final_tool = next(e for e in events if e["type"] == "tool.finished")
    require(final_tool["payload"]["output"]["text"] == fixture["expected"]["toolOutput"],
            "Incorrect final output fixture")
    tool_fragment = events[12]["payload"]["delta"]
    require(json.loads(tool_fragment) == events[13]["payload"]["block"]["arguments"],
            "Tool argument fragment does not match completed block")
    messages = [e for e in events if e["type"] == "message.completed"]
    require(messages[-1]["payload"]["blocks"][0]["text"] == fixture["expected"]["assistantText"],
            "Incorrect final message fixture")
    require(fixture["expected"]["lastSeq"] == len(events), "Incorrect lastSeq")
    final_run = [e for e in events if e["type"] == "run.updated"][-1]
    require(final_run["payload"]["status"] == fixture["expected"]["runStatus"], "Incorrect run fixture")
    for event in events:
        envelope = {**fixture["envelopeDefaults"], "sessionId": fixture["sessionId"],
                    "runId": fixture["runId"], "timestamp": fixture["timestamp"], **event}
        require(set(envelope) == {"schemaVersion", "sessionId", "runId", "timestamp", "seq", "type", "payload"},
                "Fixture envelope expansion differs")


def expect_integrity_error(db: sqlite3.Connection, sql: str, args: tuple = ()) -> None:
    db.execute("SAVEPOINT expected_failure")
    try:
        db.execute(sql, args)
    except sqlite3.IntegrityError:
        db.execute("ROLLBACK TO expected_failure")
        db.execute("RELEASE expected_failure")
        return
    db.execute("ROLLBACK TO expected_failure")
    db.execute("RELEASE expected_failure")
    raise AssertionError(f"Expected a schema constraint failure: {sql}")


def check_schema() -> int:
    require(sqlite3.sqlite_version_info >= (3, 38, 0), "SQLite >= 3.38 required")
    schema = (ROOT / "docs/schema-v1.sql").read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="pi-remote-docs-") as temp:
        db = sqlite3.connect(Path(temp) / "reference.sqlite")
        try:
            db.executescript(schema)
            require(db.execute("PRAGMA journal_mode").fetchone()[0] == "wal", "WAL not enabled")
            require(db.execute("PRAGMA foreign_keys").fetchone()[0] == 1, "FKs not enabled")
            require(db.execute("PRAGMA user_version").fetchone()[0] == 1, "Wrong schema version")
            db.execute("INSERT INTO users VALUES ('u','Synthetic owner',0)")
            db.execute("INSERT INTO devices(id,user_id,name,token_hash,created_at) VALUES ('d','u','Synthetic phone','not-a-real-token',0)")
            db.execute("INSERT INTO projects(id,user_id,name,root_path,workspace_key,root_identity,created_at,last_activity_at) VALUES ('p','u','Synthetic project','/workspaces/demo','/workspaces/demo','1:2',0,0)")
            for sid in ("s1", "s2"):
                db.execute("INSERT INTO sessions(id,project_id,title,created_at,last_activity_at) VALUES (?,'p','Synthetic session',0,0)", (sid,))
            command_sql = "INSERT INTO commands(id,user_id,device_id,session_id,scope,client_command_id,kind,payload_hash,payload_json,state,created_at) VALUES (?,'u','d',?,'test',?,'prompt','hash','{}','queued',0)"
            db.execute(command_sql, ("c1", "s1", "key1"))
            db.execute(command_sql, ("c2", "s2", "key2"))
            db.execute(command_sql, ("c3", "s1", "key3"))
            expect_integrity_error(db, command_sql, ("duplicate", "s1", "key1"))
            db.execute("INSERT INTO runs(id,session_id,command_id,kind,status,created_at) VALUES ('r1','s1','c1','prompt','running',0)")
            db.execute("INSERT INTO runs(id,session_id,command_id,kind,status,created_at) VALUES ('r3','s1','c3','prompt','queued',0)")
            expect_integrity_error(db, "UPDATE runs SET status='running' WHERE id='r3'")
            expect_integrity_error(db, "INSERT INTO runs(id,session_id,command_id,kind,status,created_at) VALUES ('bad','s1','c2','prompt','queued',0)")
            event_sql = "INSERT INTO events VALUES (?,?,'r1',1,'run.updated',0,?)"
            db.execute(event_sql, ("s1", 1, "{}"))
            expect_integrity_error(db, event_sql, ("s1", 1, "{}"))
            expect_integrity_error(db, event_sql, ("s2", 1, "{}"))
            expect_integrity_error(db, event_sql, ("s1", 2, "{"))
            expect_integrity_error(db, event_sql, ("s1", 9007199254740992, "{}"))
            db.execute("INSERT INTO ipc_batches VALUES ('epoch',1,'s1',1,1,'hash')")
            expect_integrity_error(db, "INSERT INTO ipc_batches VALUES ('epoch',1,'s1',1,1,'hash')")
            db.execute("INSERT INTO timeline_items VALUES ('s1','item','message',1,1,'{}')")
            require(not db.execute("PRAGMA foreign_key_check").fetchall(), "Reference FK violations")
            require(db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "Reference DB corruption")
            tables = db.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
            require(tables == 12, f"Unexpected table count: {tables}")
            db.commit()
            return tables
        finally:
            db.close()


def main() -> None:
    count = check_markdown()
    check_traceability()
    check_fixture()
    tables = check_schema()
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    require("MIT License" in license_text and 'THE SOFTWARE IS PROVIDED "AS IS"' in license_text,
            "MIT license missing")
    print(f"PASS: {count} Markdown files and links; 13 stages; 12 requirements; 30 acceptance cases.")
    print(f"PASS: 26 synthetic events; {tables} SQLite reference tables and integrity constraints; MIT license.")
    print("Application, live SDK, Docker and device checks: NOT RUN (documentation-only repository).")


if __name__ == "__main__":
    main()
