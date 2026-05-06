import sqlite3, os, json, sys

db = os.path.join(os.environ['LOCALAPPDATA'], 'claude-monitor', 'data.db')
c = sqlite3.connect(db)
cur = c.cursor()
cur.execute("""
    SELECT ts, agent_id, event_type, severity, message, data_json
    FROM audit_events
    WHERE event_type IN ('process_exit','agent_appears_stuck','latency_budget_exceeded','tool_call_budget_exceeded','max_turns_exceeded','context_overflow_risk','cost_budget_exceeded')
    ORDER BY ts DESC LIMIT 15
""")
for r in cur.fetchall():
    ts, aid, et, sev, msg, data = r
    print(f"{ts} | {et} | {sev} | agent={aid[:8] if aid else '-'}")
    print(f"  msg: {msg}")
    if data:
        try:
            d = json.loads(data)
            stderr = d.get('stderr_tail') or []
            if stderr:
                print("  stderr_tail:")
                for line in stderr[-10:]:
                    print(f"    | {line}")
            else:
                print(f"  data: {json.dumps({k:v for k,v in d.items() if k != 'stderr_tail'})}")
        except Exception:
            print(f"  data: {data[:200]}")
    print()
