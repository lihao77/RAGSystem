import time
from pathlib import Path
import tempfile

from conversation_store import ConversationStore


def run_perf_test(messages_per_session: int = 50, sessions: int = 50):
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "perf.db"
        store = ConversationStore(db_path=str(db_path), cleanup_interval_seconds=60, session_ttl_days=30)

        write_latencies = []
        for s in range(sessions):
            session_id = f"session_{s}"
            store.create_session(session_id=session_id, user_id="u1")
            for i in range(messages_per_session):
                start = time.perf_counter()
                store.add_message(session_id=session_id, role="user", content=f"m{i}")
                write_latencies.append((time.perf_counter() - start) * 1000)

        start = time.perf_counter()
        data = store.list_messages(session_id="session_0", limit=20, offset=0)
        query_ms = (time.perf_counter() - start) * 1000

        write_avg = sum(write_latencies) / len(write_latencies)
        write_p95 = sorted(write_latencies)[int(len(write_latencies) * 0.95) - 1]

        return {
            "write_avg_ms": write_avg,
            "write_p95_ms": write_p95,
            "query_ms": query_ms,
            "items": len(data["items"]),
            "total": data["total"]
        }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions", type=int, default=50)
    parser.add_argument("--messages-per-session", type=int, default=50)
    args = parser.parse_args()

    result = run_perf_test(messages_per_session=args.messages_per_session, sessions=args.sessions)
    print(result)
