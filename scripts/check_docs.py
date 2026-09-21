"""Validate documentation and contracts, independently of application tests.

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
        table_width = None
        inside_fence = False
        for number, line in enumerate(content.splitlines(), 1):
            if line.lstrip().startswith("```"):
                inside_fence = not inside_fence
                table_width = None
                continue
            if inside_fence or not line.startswith("|"):
                table_width = None
                continue
            width = len(re.split(r"(?<!\\)\|", line)) - 2
            if table_width is None:
                table_width = width
            require(width == table_width,
                    f"Table column mismatch: {path.relative_to(ROOT)}:{number}")
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
    checks = {f"AT{i:02d}" for i in range(1, 33)}
    requirements = {f"FR{i:02d}" for i in range(1, 15)}
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
    require(len(at_rows) == len(checks) and {row[0] for row in at_rows} == checks, "Acceptance IDs differ")
    require(set(re.findall(r"\bFR\d{2}\b", acceptance)) == requirements, "Requirement coverage differs")
    for check, frs, owners in at_rows:
        require(set(re.findall(r"FR\d{2}", frs)) <= requirements, f"Unknown FR at {check}")
        require(set(re.findall(r"S\d{2}", owners)) <= set(stages), f"Unknown stage at {check}")
    plan_edges = {(stage, check) for stage, _, _, refs in rows
                  for check in re.findall(r"AT\d{2}", refs)}
    acceptance_edges = {(stage, check) for check, _, owners in at_rows
                        for stage in re.findall(r"S\d{2}", owners)}
    require(plan_edges == acceptance_edges,
            f"Stage/check ownership differs: {sorted(plan_edges ^ acceptance_edges)}")
    progress_rows = re.findall(r"^\| (S\d{2}) \| ([a-z_]+) \|", progress, re.M)
    require([row[0] for row in progress_rows] == stages, "Progress table differs")
    require(all(status in {"not_started", "in_progress", "passed", "blocked"}
                for _, status in progress_rows), "Unknown progress state")
    for stage in stages:
        require(f"pnpm verify:{stage}" in plan, f"Missing verification entry: {stage}")
    bash_parity = (ROOT / "docs/bash-compatibility.md").read_text(encoding="utf-8")
    require(re.findall(r"^\| (B\d{2})\b", bash_parity, re.M) == [f"B{i:02d}" for i in range(1, 9)],
            "Bash/TUI comparison matrix differs")
    require({stage for stage, check in plan_edges if check == "AT31"}
            == {"S02", "S06", "S08", "S10", "S12"}, "Bash parity stage ownership differs")
    tui_parity = (ROOT / "docs/tui-experience.md").read_text(encoding="utf-8")
    require(re.findall(r"^\| (T\d{2})\b", tui_parity, re.M) == [f"T{i:02d}" for i in range(1, 9)],
            "Common mobile workflow comparison matrix differs")
    require({stage for stage, check in plan_edges if check == "AT32"}
            == {"S02", "S06", "S07", "S10", "S12"}, "Common mobile workflow parity stage ownership differs")


def check_run_operation(events: list[dict], run_id: str, expected: dict) -> None:
    """Check the operation lifecycle in each complete synthetic Run example."""
    operations = [(i, e) for i, e in enumerate(events) if e["type"] == "operation.updated"]
    require(len(operations) == 2, "Run example must include operation start and end")
    (start_index, start), (end_index, end) = operations
    require(start["payload"]["operationId"] == end["payload"]["operationId"], "Operation ID changed")
    require(start["payload"]["kind"] == end["payload"]["kind"] == "run", "Wrong Run operation kind")
    require(all(e.get("runId", run_id) == run_id for _, e in operations), "Operation belongs to another Run")
    require(start["payload"]["status"] == "running", "Missing operation start")
    terminal = {"completed": "completed", "failed": "failed", "aborted": "cancelled", "interrupted": "interrupted"}
    require(end["payload"]["status"] == terminal[expected["runStatus"]], "Wrong Run operation terminal state")
    require(expected["activeOperationCount"] == 0, "Ended Run left an active operation")
    content_indices = [i for i, e in enumerate(events) if e["type"].startswith(("message.", "content.", "tool."))]
    require(content_indices and start_index < min(content_indices) <= max(content_indices) < end_index,
            "Run content escapes its operation lifecycle")


def check_fixture() -> int:
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
    tool_fragment = next(e["payload"]["delta"] for e in events
                         if e["type"] == "content.delta" and e["payload"]["blockId"] == "a1")
    tool_block = next(e["payload"]["block"] for e in events
                      if e["type"] == "content.ended" and e["payload"]["block"]["id"] == "a1")
    require(json.loads(tool_fragment) == tool_block["arguments"],
            "Tool argument fragment does not match completed block")
    messages = [e for e in events if e["type"] == "message.completed"]
    require(messages[-1]["payload"]["blocks"][0]["text"] == fixture["expected"]["assistantText"],
            "Incorrect final message fixture")
    require(fixture["expected"]["lastSeq"] == len(events), "Incorrect lastSeq")
    final_run = [e for e in events if e["type"] == "run.updated"][-1]
    require(final_run["payload"]["status"] == fixture["expected"]["runStatus"], "Incorrect run fixture")
    check_run_operation(events, fixture["runId"], fixture["expected"])
    for event in events:
        envelope = {**fixture["envelopeDefaults"], "sessionId": fixture["sessionId"],
                    "runId": fixture["runId"], "operationId": fixture["operationId"],
                    "timestamp": fixture["timestamp"], **event}
        require(set(envelope) == {"schemaVersion", "sessionId", "runId", "operationId", "timestamp", "seq", "type", "payload"},
                "Fixture envelope expansion differs")
        require(envelope["operationId"] == fixture["operationId"], "Stream Operation binding differs")
        if event["type"] == "operation.updated":
            require(event["payload"]["operationId"] == envelope["operationId"], "Stream Operation envelope differs")
    return len(events)


def check_interruption_fixture() -> int:
    """Check the published synthetic assertions, not the future S03 reducer."""
    fixture = json.loads((ROOT / "docs/examples/interrupted.json").read_text(encoding="utf-8"))
    protocol = (ROOT / "docs/protocol-v1.md").read_text(encoding="utf-8")
    event_types = set(re.findall(r"^\| ([a-z_]+\.[a-z_]+) \|", protocol, re.M))
    total = 0
    for scenario in fixture["scenarios"]:
        events, expected = scenario["events"], scenario["expected"]
        require([e["seq"] for e in events] == list(range(1, len(events) + 1)),
                f"Interruption event sequence gap: {scenario['name']}")
        require(all(e["type"] in event_types for e in events), "Undocumented interruption event")
        check_run_operation(events, scenario["runId"], expected)
        opened, complete_ids, partials = {}, [], []
        final_run, queue, seal_reason = None, None, None
        for event in events:
            envelope = {**fixture["envelopeDefaults"], "sessionId": scenario["sessionId"],
                        "runId": scenario["runId"], "operationId": scenario["operationId"],
                        "timestamp": fixture["timestamp"], **event}
            require(set(envelope) == {"schemaVersion", "sessionId", "runId", "operationId", "timestamp", "seq", "type", "payload"},
                    "Interruption envelope expansion differs")
            kind, payload, seq = event["type"], event["payload"], event["seq"]
            if kind.startswith(("message.", "content.", "tool.")) or kind == "run.content_sealed":
                require(envelope["runId"] == scenario["runId"], "Content must belong to its Run")
                require(envelope["operationId"] == scenario["operationId"], "Content operation differs")
                require(final_run not in {"failed", "aborted", "interrupted"}, "Content after terminal Run")
            if kind in {"message.started", "tool.started"}:
                item_kind = kind.split(".")[0]
                item_id = payload["messageId"] if item_kind == "message" else payload["toolCallId"]
                require(item_id not in opened and item_id not in complete_ids, "Reused item ID")
                data = {**payload, "blocks": []} if item_kind == "message" else {
                    **payload, "output": {"text": "", "truncated": False}}
                opened[item_id] = {"itemId": item_id, "runId": envelope["runId"],
                                   "operationId": envelope["operationId"],
                                   "kind": item_kind, "ordinalSeq": seq, "data": data}
            elif kind == "content.started":
                block = {"id": payload["blockId"], "index": payload["index"], "kind": payload["kind"]}
                if block["kind"] == "tool_call":
                    block.update(toolCallId=payload["toolCallId"], toolName=payload["toolName"],
                                 argumentsText="", argumentsIncomplete=True)
                else:
                    block["text"] = ""
                opened[payload["messageId"]]["data"]["blocks"].append(block)
            elif kind == "content.delta":
                block = next(b for b in opened[payload["messageId"]]["data"]["blocks"]
                             if b["id"] == payload["blockId"])
                field = "argumentsText" if block["kind"] == "tool_call" else "text"
                block[field] += payload["delta"]
            elif kind == "message.completed":
                opened.pop(payload["messageId"])
                complete_ids.append(payload["messageId"])
            elif kind == "tool.updated":
                opened[payload["toolCallId"]]["data"]["output"] = payload["output"]
            elif kind == "run.content_sealed":
                seal_reason = payload["reason"]
                require(seal_reason in {"failed", "aborted", "interrupted"}, "Invalid seal reason")
                for item in opened.values():
                    item.update(completeness="partial", endReason=seal_reason, finalizedSeq=seq)
                    if item["kind"] == "tool":
                        item["data"]["outcome"] = "unknown"
                        require("exitCode" not in item["data"] and "isError" not in item["data"],
                                "Unknown tool outcome invented a final result")
                    partials.append(item)
                opened.clear()
            elif kind == "run.updated":
                final_run = payload["status"]
                if final_run in {"failed", "aborted", "interrupted"}:
                    require(seal_reason == final_run and not opened, "Terminal Run lacks content seal")
            elif kind == "queue.updated":
                if queue:
                    require(payload["version"] > queue["version"], "Queue version did not advance")
                queue = payload
        require(partials == expected["partialItems"], f"Partial projection differs: {scenario['name']}")
        require(complete_ids == expected["completeItemIds"], "Completed history changed during sealing")
        require(len(opened) == expected["liveItemCount"] == 0, "Interrupted live item leaked")
        require(final_run == expected["runStatus"] == seal_reason, "Incorrect terminal Run assertion")
        require(queue is not None, "Missing queue assertion")
        has_old_items = expected["queuedCount"] > 0
        require(queue["state"] == expected["queueState"] == ("paused" if has_old_items else "ready"),
                "Only nonempty old queues should pause")
        require(queue["version"] == expected["queueVersion"], "Incorrect queue version assertion")
        pause = {"runId": scenario["runId"], "reason": seal_reason} if has_old_items else None
        require(queue["pause"] == pause, "Wrong pause target or empty queue retained pause")
        require(len(queue["items"]) == expected["queuedCount"], "Lost queued follow-up")
        require(len(events) == expected["lastSeq"], "Incorrect interruption lastSeq")
        total += len(events)
    return total


def check_initialization_fixture() -> int:
    """Validate the runless dialog contract, without claiming SDK execution."""
    fixture = json.loads((ROOT / "docs/examples/initialization-dialog.json").read_text(encoding="utf-8"))
    events, expected = fixture["events"], fixture["expected"]
    protocol = (ROOT / "docs/protocol-v1.md").read_text(encoding="utf-8")
    event_types = set(re.findall(r"^\| ([a-z_]+\.[a-z_]+) \|", protocol, re.M))
    require([e["seq"] for e in events] == list(range(1, len(events) + 1)), "Initialization sequence gap")
    require(all(e["type"] in event_types for e in events), "Undocumented initialization event")
    require(fixture["reply"]["kind"] == "respond", "Missing explicit initialization answer")
    reply = fixture["reply"]["payload"]
    require(set(reply) == {"interactionId", "operationId", "response"}, "Runless respond shape differs")
    operations, interactions = {}, {}
    active, pending = set(), set()
    waiting_operations = waiting_interactions = run_count = 0
    for event in events:
        envelope = {**fixture["envelopeDefaults"], "sessionId": fixture["sessionId"],
                    "runId": fixture["runId"], "operationId": fixture["operationId"],
                    "timestamp": fixture["timestamp"], **event}
        require(set(envelope) == {"schemaVersion", "sessionId", "runId", "operationId", "timestamp", "seq", "type", "payload"},
                "Initialization envelope expansion differs")
        require(envelope["runId"] is None, "Initialization must not invent a Run")
        kind, payload = event["type"], event["payload"]
        if kind == "operation.updated":
            oid, status = payload["operationId"], payload["status"]
            require(envelope["operationId"] == oid, "Envelope operation differs")
            require(oid == reply["operationId"] and payload["kind"] == "initialize",
                    "Initialization operation association differs")
            if oid not in operations:
                require(status == "running", "Operation must start before waiting")
            else:
                require(oid in active, "Terminal operation reopened")
            operations[oid] = payload
            if status in {"running", "waiting_input"}:
                active.add(oid)
                if status == "waiting_input":
                    require(any(interactions[i]["operationId"] == oid for i in pending),
                            "Waiting operation has no pending dialog")
                    waiting_operations = max(waiting_operations, len(active))
                    waiting_interactions = max(waiting_interactions, len(pending))
            else:
                require(status == "completed", "Initialization silently cancelled or failed")
                require(not any(interactions[i]["operationId"] == oid for i in pending),
                        "Operation ended with an orphaned dialog")
                active.remove(oid)
        elif kind == "interaction.requested":
            iid, oid = payload["interactionId"], payload["operationId"]
            require(oid in active and payload["origin"] == operations[oid]["kind"],
                    "Dialog has no matching active operation")
            require(iid not in interactions, "Reused interaction ID")
            require(iid == reply["interactionId"] and payload["kind"] == "confirm", "Dialog shape differs")
            interactions[iid] = {**payload, "status": "pending"}
            pending.add(iid)
        elif kind == "interaction.resolved":
            iid = payload["interactionId"]
            require(iid in pending, "Dialog resolved without pending state")
            require(operations[interactions[iid]["operationId"]]["status"] == "waiting_input",
                    "Dialog did not wait for its answer")
            require(payload["status"] == "resolved" and payload["response"] == reply["response"],
                    "Initialization did not deliver the explicit answer")
            interactions[iid].update(payload)
            pending.remove(iid)
        elif kind == "run.updated":
            run_count += 1
        else:
            raise AssertionError(f"Unexpected event in initialization example: {kind}")
    require(run_count == expected["runCount"] == 0, "Initialization created a model Run")
    require(waiting_operations == expected["waitingOperationCount"] == 1, "Missing waiting operation")
    require(waiting_interactions == expected["waitingInteractionCount"] == 1, "Missing waiting dialog")
    require(len(active) == expected["activeOperationCount"] == 0, "Completed operation leaked")
    require(len(pending) == expected["pendingInteractionCount"] == 0, "Resolved interaction leaked")
    require(operations[reply["operationId"]]["status"] == expected["operationStatus"], "Wrong final operation")
    require(interactions[reply["interactionId"]]["status"] == expected["interactionStatus"], "Wrong final dialog")
    require(interactions[reply["interactionId"]]["response"] == expected["response"], "Wrong final answer")
    require(len(events) == expected["lastSeq"], "Incorrect initialization lastSeq")
    return len(events)


def check_native_fixture() -> int:
    """Check published ownership/terminal assertions, not the future SDK adapter or reducer."""
    fixture = json.loads((ROOT / "docs/examples/native-runtime.json").read_text(encoding="utf-8"))
    protocol = (ROOT / "docs/protocol-v1.md").read_text(encoding="utf-8")
    event_types = set(re.findall(r"^\| ([a-z_]+\.[a-z_]+) \|", protocol, re.M))
    total = 0
    for scenario in fixture["scenarios"]:
        seqs, operations, runs, opened, sealed, inputs, commands = {}, {}, {}, {}, {}, {}, {}
        complete_ids, partials, queue = [], {}, None
        expected = scenario["expected"]
        command_sessions = {c["commandId"]: c["sessionId"] for c in scenario.get("commands", [])}
        delivered_after_parent = set()
        queued_runs = set()
        for raw in scenario["events"]:
            e = {**fixture["envelopeDefaults"], "sessionId": scenario["sessionId"],
                 "timestamp": fixture["timestamp"], **raw}
            require(set(e) == {"schemaVersion", "sessionId", "runId", "operationId", "timestamp", "seq", "type", "payload"},
                    "Native envelope expansion differs")
            sid, oid, rid, kind, p = e["sessionId"], e["operationId"], e["runId"], e["type"], e["payload"]
            require(e["seq"] == seqs.get(sid, 0) + 1, "Native per-Session sequence gap")
            seqs[sid] = e["seq"]
            require(kind in event_types, "Undocumented native event")
            if kind == "operation.updated":
                require(oid == p["operationId"], "Native operation envelope mismatch")
                if oid in operations:
                    require(operations[oid]["status"] in {"running", "waiting_input"}, "Terminal Operation reopened")
                    require((sid, rid, p["kind"]) == (operations[oid]["sessionId"], operations[oid]["runId"], operations[oid]["kind"]),
                            "Operation binding changed")
                else:
                    require(p["status"] == "running", "Operation must start before content")
                    if "parentOperationId" in p:
                        require(p["parentOperationId"] in operations, "Unknown parent operation")
                if p["status"] not in {"running", "waiting_input"}:
                    require(not any(item["operationId"] == oid for item in opened.values()), "Operation ended with unsealed content")
                operations[oid] = {**p, "sessionId": sid, "runId": rid}
            elif kind == "run.updated":
                require(rid is not None and oid in operations, "Run lacks operation")
                require((operations[oid]["sessionId"], operations[oid]["runId"], operations[oid]["kind"]) == (sid, rid, "run"),
                        "Run operation association differs")
                if rid not in runs:
                    require(p.get("source") in {"command", "extension", "runtime"}, "Run lacks source")
                    require(p["source"] != "command" or p.get("commandId"), "External Run lacks Command")
                    require(not p.get("commandId") or p["commandId"] in command_sessions, "Unknown causal Command")
                    runs[rid] = {"sessionId": sid, "operationId": oid, **p}
                else:
                    require(runs[rid]["operationId"] == oid and runs[rid]["sessionId"] == sid, "Run moved Session")
                    runs[rid].update(p)
                if p["status"] == "queued":
                    queued_runs.add(rid)
                require(sum(r["sessionId"] == sid and r["status"] in {"running", "waiting_input"}
                            for r in runs.values()) <= 1, "Two active model Runs in a Session")
            elif kind.startswith(("message.", "content.")) or kind.endswith(".content_sealed"):
                require(oid in operations and operations[oid]["status"] in {"running", "waiting_input"},
                        "Content outside a live Operation")
                require((sid, rid) == (operations[oid]["sessionId"], operations[oid]["runId"]), "Content binding differs")
                parent = operations[oid].get("parentOperationId")
                if parent and operations[parent]["status"] == "completed":
                    delivered_after_parent.add(oid)
                if kind == "message.started":
                    mid = p["messageId"]
                    require(mid not in opened and mid not in sealed, "Reused native message ID")
                    if p["role"] in {"custom", "bash"}:
                        require(p["role"] in p, "Missing role metadata on started content")
                    opened[mid] = {"operationId": oid, "runId": rid, "text": "", "data": p}
                elif kind == "content.started":
                    require(p["messageId"] in opened, "Block before message")
                elif kind == "content.delta":
                    item = opened[p["messageId"]]
                    require(item["operationId"] == oid, "Delta belongs to another Operation")
                    item["text"] += p["delta"]
                elif kind == "message.completed":
                    item = opened.pop(p["messageId"])
                    require((item["operationId"], item["runId"]) == (oid, rid), "Completion ownership differs")
                    if p["role"] in {"custom", "bash"}:
                        require(p["role"] in p, "Missing final role metadata")
                    if p["role"] == "bash":
                        require(p["bash"]["outcome"] in {"succeeded", "failed", "aborted"}, "Incomplete Bash claimed complete")
                    sealed[p["messageId"]] = {**item, "data": p}
                    complete_ids.append(p["messageId"])
                elif kind.endswith(".content_sealed"):
                    require((kind == "run.content_sealed") == (rid is not None), "Wrong sealing scope")
                    for mid, item in list(opened.items()):
                        if item["operationId"] != oid:
                            continue
                        partial = {k: item[k] for k in ("operationId", "runId", "text")}
                        partial["endReason"] = p["reason"]
                        if item["data"]["role"] == "bash":
                            require(not {"exitCode", "cancelled"} & item["data"]["bash"].keys(), "Partial Bash invented a result")
                            partial["outcome"] = "unknown"
                        partials[mid] = partial
                        sealed[mid] = opened.pop(mid)
            elif kind == "input.updated":
                require(rid in runs and oid == runs[rid]["operationId"], "Input targets another execution")
                iid = p["inputId"]
                if iid not in inputs:
                    require(p["state"] == "queued" and "content" in p, "Input lacks initial content")
                    inputs[iid] = {**p, "runId": rid}
                else:
                    require(inputs[iid]["state"] == "queued", "Consumed/returned input was replayed")
                    require(p["state"] in {"consumed", "returned", "unknown"}, "Invalid input transition")
                    require(inputs[iid]["runId"] == rid, "Input moved to another Run")
                    inputs[iid].update(p)
            elif kind == "command.updated":
                cid = p["commandId"]
                require(sid == command_sessions[cid], "Causal Command moved to destination Session")
                commands[cid] = {**commands.get(cid, {}), **p}
            elif kind == "queue.updated":
                require(oid is None and rid is None, "Application queue acquired execution ownership")
                queue = p
            else:
                raise AssertionError(f"Unchecked native fixture event: {kind}")
        require(len(runs) == expected["runCount"], "Invented or missing model Run")
        require(sum(op["status"] in {"running", "waiting_input"} for op in operations.values())
                == expected["activeOperationCount"] == 0, "Active operation leaked")
        require(len(opened) == expected["liveItemCount"] == 0, "Native partial content leaked")
        require(complete_ids == expected["completeItemIds"] and partials == expected["partialItems"], "Native timeline assertions differ")
        if "runlessItemIds" in expected:
            require({mid for mid, item in sealed.items() if item["runId"] is None} == set(expected["runlessItemIds"]), "Runless content acquired a Run")
            require(expected["deliveredAfterParentCompleted"] in delivered_after_parent, "Missing deferred child delivery")
        if "autonomousRunIds" in expected:
            require({rid for rid, r in runs.items() if not r.get("commandId")} == set(expected["autonomousRunIds"]), "Autonomous execution invented Command")
        for cid, associations in expected.get("commandRuns", {}).items():
            actual = [{"runId": rid, "sessionId": r["sessionId"]} for rid, r in runs.items() if r.get("commandId") == cid]
            require(actual == associations == commands[cid]["runs"], "Multi-Run command projection differs")
        if "recoveredInputIds" in expected:
            returned = [iid for iid, p in inputs.items() if p["state"] == "returned"]
            require(returned == expected["recoveredInputIds"], "Unconsumed draft lost or duplicated")
            require(all(inputs[i]["content"] == expected["recoveredContent"] for i in returned), "Draft lost attachments or text")
            require([i for i, p in inputs.items() if p["state"] == "consumed"] == expected["consumedInputIds"], "Consumed input returned again")
            require(sum(p["state"] == "queued" for p in inputs.values()) == expected["pendingInputCount"] == 0, "SDK input still queued")
        if "cancelledCommand" in expected:
            command = commands[expected["cancelledCommand"]]
            require(command["kind"] == "prompt" and command["targetRunId"] in runs, "Missing targeted prompt recovery")
            require(command["state"] == "cancelled" and command["result"]["reason"] == expected["cancelReason"], "Stale targeted prompt preserved")
        if "queuedRunCount" in expected:
            require(len(queued_runs) == expected["queuedRunCount"] == 0, "Recovered control created queued Run")
            require(queue and queue["state"] == expected["queueState"] and len(queue["items"]) == expected["queueItemCount"], "Recovery introduced queue membership")
        total += len(scenario["events"])
    return total


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
            expect_integrity_error(db, "UPDATE sessions SET pi_persistence_state='persisted' WHERE id='s1'")
            expect_integrity_error(db, "UPDATE sessions SET pi_session_id='pi-s1' WHERE id='s1'")
            db.execute("UPDATE sessions SET pi_persistence_state='unflushed',pi_session_id='pi-s1',pi_session_file='/state/pi/s1.jsonl' WHERE id='s1'")
            db.execute("UPDATE sessions SET pi_persistence_state='persisted' WHERE id='s1'")
            expect_integrity_error(db, "UPDATE sessions SET pi_session_file=NULL WHERE id='s1'")
            command_sql = "INSERT INTO commands(id,user_id,device_id,session_id,scope,client_command_id,kind,payload_hash,payload_json,state,created_at) VALUES (?,'u','d',?,'test',?,'prompt','hash','{}','queued',0)"
            db.execute(command_sql, ("c1", "s1", "key1"))
            db.execute(command_sql, ("c2", "s2", "key2"))
            db.execute(command_sql, ("c3", "s1", "key3"))
            expect_integrity_error(db, command_sql, ("duplicate", "s1", "key1"))
            receipt = '{"commandId":"c1","state":"queued"}'
            result = '{"actualConfig":{"model":{"provider":"synthetic","id":"example"}}}'
            db.execute("UPDATE commands SET response_status=202,response_json=? WHERE id='c1'", (receipt,))
            db.execute("UPDATE commands SET result_json=? WHERE id='c1'", (result,))
            expect_integrity_error(db, "UPDATE commands SET result_json='{' WHERE id='c1'")
            require(db.execute("SELECT response_json,result_json FROM commands WHERE id='c1'").fetchone()
                    == (receipt, result), "Final result replaced the original receipt")
            run_sql = "INSERT INTO runs(id,session_id,operation_id,source,command_id,kind,status,worker_epoch,execution_scope_key,created_at) VALUES (?,?,?,?,?,'prompt',?,?,?,0)"
            db.execute(run_sql, ("r1", "s1", "op-run", "command", "c1", "running", "epoch", "synthetic-scope"))
            expect_integrity_error(db, run_sql, ("no-scope", "s2", "op-no-scope", "command", "c2", "running", None, None))
            expect_integrity_error(db, run_sql, ("no-operation", "s2", None, "extension", None, "queued", None, None))
            expect_integrity_error(db, run_sql, ("reused-operation", "s2", "op-run", "extension", None, "queued", None, None))
            expect_integrity_error(db, run_sql, ("command-without-source", "s2", "op-missing", "command", None, "queued", None, None))
            expect_integrity_error(db, run_sql, ("invalid-source", "s2", "op-invalid", "invalid", None, "queued", None, None))
            db.execute(run_sql, ("r2", "s2", "op-r2", "command", "c2", "queued", None, None))
            db.execute(run_sql, ("r3", "s1", "op-r3", "command", "c3", "queued", None, None))
            # Legal causal shapes: autonomous, one Command -> multiple Runs, destination Session differs.
            # Same-owner business validation is required in S04; these SQL tests do not implement it.
            db.execute(run_sql, ("r-auto", "s1", "op-auto", "extension", None, "completed", None, None))
            db.execute(run_sql, ("r-next", "s1", "op-next", "extension", "c1", "completed", None, None))
            db.execute(run_sql, ("r-destination", "s2", "op-destination", "extension", "c1", "completed", None, None))
            require(db.execute("SELECT count(*) FROM runs WHERE command_id='c1'").fetchone()[0] == 3,
                    "Causal Command cannot reference multiple Runs")
            expect_integrity_error(db, "UPDATE commands SET target_run_id='r2' WHERE id='c1'")
            db.execute("UPDATE commands SET target_run_id='r1' WHERE id='c3'")
            expect_integrity_error(db, "UPDATE runs SET status='running',worker_epoch='epoch3',execution_scope_key='synthetic-scope' WHERE id='r3'")
            # Different Sessions in the same project may generate concurrently.
            db.execute("UPDATE runs SET status='running',worker_epoch='epoch2',execution_scope_key='synthetic-scope' WHERE id='r2'")
            interaction_sql = "INSERT INTO interactions(id,session_id,operation_id,origin,run_id,command_id,worker_epoch,kind,payload_json,status,created_at) VALUES (?,'s1',?,?,?,?,'epoch','confirm','{}','pending',0)"
            db.execute(interaction_sql, ("i-init", "op-init", "initialize", None, None))
            db.execute(interaction_sql, ("i-config", "op-config", "configure", None, "c3"))
            db.execute(interaction_sql, ("i-run", "op-run", "run", "r1", "c1"))
            expect_integrity_error(db, interaction_sql, ("i-no-op", None, "initialize", None, None))
            expect_integrity_error(db, interaction_sql, ("i-no-run", "op-bad", "run", None, "c1"))
            expect_integrity_error(db, interaction_sql, ("i-bad-origin", "op-bad", "invalid", None, None))
            expect_integrity_error(db, interaction_sql, ("i-other-run", "op-bad", "run", "r2", "c1"))
            db.execute(interaction_sql, ("i-causal-command", "op-cross-source", "extension", None, "c2"))
            expect_integrity_error(db, "UPDATE interactions SET response_command_id='c2' WHERE id='i-init'")
            db.execute(command_sql, ("c4", "s1", "key4"))
            db.execute("UPDATE commands SET kind='respond' WHERE id='c4'")
            db.execute("UPDATE interactions SET response_command_id='c4',response_json='{\"confirmed\":true}',status='resolved',resolved_at=1 WHERE id='i-init'")
            require(db.execute("SELECT run_id,command_id FROM interactions WHERE id='i-init'").fetchone()
                    == (None, None), "Initialization answer acquired an invented Run or initiating command")
            expect_integrity_error(db, "UPDATE sessions SET queue_state='paused' WHERE id='s1'")
            expect_integrity_error(db, "UPDATE sessions SET queue_state='paused',queue_pause_run_id='r2',queue_pause_reason='interrupted' WHERE id='s1'")
            db.execute("UPDATE runs SET status='interrupted' WHERE id='r1'")
            db.execute("UPDATE sessions SET queue_state='paused',queue_pause_run_id='r1',queue_pause_reason='interrupted',queue_version=1 WHERE id='s1'")
            expect_integrity_error(db, "UPDATE sessions SET queue_state='ready' WHERE id='s1'")
            expect_integrity_error(db, "UPDATE sessions SET queue_version=-1 WHERE id='s1'")
            event_sql = "INSERT INTO events(session_id,seq,run_id,operation_id,schema_version,type,timestamp,payload_json) VALUES (?,?,'r1','op-run',1,'run.updated',0,?)"
            db.execute(event_sql, ("s1", 1, "{}"))
            expect_integrity_error(db, event_sql, ("s1", 1, "{}"))
            expect_integrity_error(db, event_sql, ("s2", 1, "{}"))
            expect_integrity_error(db, event_sql, ("s1", 2, "{"))
            expect_integrity_error(db, event_sql, ("s1", 9007199254740992, "{}"))
            db.execute("INSERT INTO events(session_id,seq,run_id,operation_id,schema_version,type,timestamp,payload_json) VALUES ('s1',2,NULL,'op-init',1,'operation.updated',0,'{}')")
            db.execute("INSERT INTO ipc_batches VALUES ('epoch',1,'s1',1,1,'hash')")
            expect_integrity_error(db, "INSERT INTO ipc_batches VALUES ('epoch',1,'s1',1,1,'hash')")
            timeline_sql = "INSERT INTO timeline_items(session_id,item_id,operation_id,run_id,kind,completeness,end_reason,ordinal_seq,finalized_seq,payload_json) VALUES ('s1',?,'op-run','r1','message',?,?,1,1,'{}')"
            db.execute(timeline_sql, ("complete-item", "complete", None))
            db.execute(timeline_sql, ("partial-item", "partial", "interrupted"))
            expect_integrity_error(db, timeline_sql, ("no-reason", "partial", None))
            expect_integrity_error(db, timeline_sql, ("unexpected-reason", "complete", "interrupted"))
            expect_integrity_error(db, "UPDATE timeline_items SET run_id='r2' WHERE item_id='partial-item'")
            db.execute("INSERT INTO timeline_items(session_id,item_id,operation_id,run_id,kind,completeness,ordinal_seq,finalized_seq,payload_json) VALUES ('s1','custom-no-run','op-init',NULL,'message','complete',2,2,'{}')")
            expect_integrity_error(db, "UPDATE timeline_items SET operation_id=NULL WHERE item_id='custom-no-run'")
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
    events = check_fixture() + check_interruption_fixture() + check_initialization_fixture() + check_native_fixture()
    tables = check_schema()
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    require("MIT License" in license_text and 'THE SOFTWARE IS PROVIDED "AS IS"' in license_text,
            "MIT license missing")
    print(f"PASS: {count} Markdown files and links; 13 stages; 14 requirements; 32 acceptance cases; 8 Bash + 8 common mobile workflow comparison cases.")
    print(f"PASS: {events} synthetic events; {tables} SQLite reference tables and integrity constraints; MIT license.")
    print("This command checks documentation/contracts only; application, live provider, Docker and device results are recorded separately.")


if __name__ == "__main__":
    main()
