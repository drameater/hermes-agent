from __future__ import annotations

import threading
import types

import pytest

import hermes_state
from hermes_state import SessionDB
from tui_gateway import server


class _InlineThread:
    """Run gateway and title workers synchronously for deterministic assertions."""

    def __init__(self, target=None, daemon=None, args=(), kwargs=None, name=None):
        self._target = target
        self._args = args
        self._kwargs = kwargs or {}

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)

    def is_alive(self):
        return False

    def join(self, timeout=None):
        return None


def _session(agent, *, history=None, profile_home=None):
    return {
        "agent": agent,
        "session_key": "remote-session",
        "history": list(history or []),
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": True,
        "attached_images": [],
        "image_counter": 0,
        "cols": 80,
        "slash_worker": None,
        "show_reasoning": False,
        "tool_progress_mode": "all",
        "inflight_turn": None,
        "profile_home": str(profile_home) if profile_home is not None else None,
    }


def _agent(result_messages):
    return types.SimpleNamespace(
        session_id="remote-session",
        model="test-model",
        provider="test-provider",
        base_url="https://provider.invalid/v1",
        api_key="test-key",
        api_mode="chat_completions",
        clear_interrupt=lambda: None,
        run_conversation=lambda message, **kwargs: {
            "final_response": "Gateway answer",
            "messages": result_messages,
        },
    )


@pytest.fixture()
def turn_env(monkeypatch, tmp_path):
    """Keep the real prompt/title seam while neutralizing unrelated turn hooks."""
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(server, "_hermes_home", tmp_path / "default")
    monkeypatch.setattr(server, "_wire_callbacks", lambda sid: None)
    monkeypatch.setattr(
        server, "_sync_agent_model_with_config", lambda sid, session: None
    )
    monkeypatch.setattr(server, "_session_cwd", lambda session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda session: None)
    monkeypatch.setattr(server, "_tts_stream_begin", lambda: None)
    monkeypatch.setattr(
        server, "_sync_session_key_after_compress", lambda *a, **k: None
    )
    monkeypatch.setattr(server, "_get_usage", lambda agent: {})
    monkeypatch.setattr(server, "_emit_settled_session_info", lambda *a, **k: None)
    monkeypatch.setattr(server, "_drain_queued_prompt", lambda *a, **k: False)
    monkeypatch.setattr("agent.title_generator._auto_title_enabled", lambda: True)


def _title_events(emitted):
    return [payload for event, _sid, payload in emitted if event == "session.title"]


def test_named_profile_auto_title_uses_owning_database_for_worker_lifetime(
    monkeypatch, tmp_path, turn_env
):
    default_home = tmp_path / "default"
    named_home = tmp_path / "profiles" / "code"
    default_home.mkdir(parents=True)
    named_home.mkdir(parents=True)

    default_db = SessionDB(default_home / "state.db")
    named_setup_db = SessionDB(named_home / "state.db")
    named_setup_db.create_session(session_id="remote-session", source="desktop")
    named_setup_db.close()
    monkeypatch.setattr(server, "_get_db", lambda: default_db)

    lifecycle = []
    opened = []

    class TrackingSessionDB(SessionDB):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            opened.append(self)

        def set_auto_title_if_empty(self, session_id, title):
            assert self._conn is not None
            lifecycle.append("persist")
            return super().set_auto_title_if_empty(session_id, title)

        def close(self):
            lifecycle.append("close")
            super().close()

    monkeypatch.setattr(hermes_state, "SessionDB", TrackingSessionDB)

    result_messages = [
        {"role": "user", "content": "User question"},
        {"role": "assistant", "content": "Gateway answer"},
    ]
    session = _session(_agent(result_messages), profile_home=named_home)

    emitted = []

    def capture(event, sid, payload=None):
        emitted.append((event, sid, payload))
        if event == "session.title":
            lifecycle.append("emit")

    monkeypatch.setattr(server, "_emit", capture)
    monkeypatch.setattr(
        "agent.title_generator.generate_title",
        lambda *args, **kwargs: "Named Profile Title",
    )

    server._run_prompt_submit("request", "desktop-session", session, "User question")

    named_check = SessionDB(named_home / "state.db")
    try:
        assert named_check.get_session_title("remote-session") == "Named Profile Title"
    finally:
        named_check.close()
    assert default_db.get_session("remote-session") is None
    assert _title_events(emitted) == [
        {"session_id": "remote-session", "title": "Named Profile Title"}
    ]
    assert lifecycle == ["persist", "emit", "close"]
    worker_handles = [db for db in opened if db.db_path == named_home / "state.db"]
    assert len(worker_handles) == 1
    assert worker_handles[0]._conn is None
    assert default_db._conn is not None
    default_db.close()
