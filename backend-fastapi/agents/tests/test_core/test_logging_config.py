import logging

import core.logging_config as _mod
from core.logging_config import resolve_log_level, setup_logging


def _reset():
    """Reset idempotency guard so setup_logging() takes effect again."""
    _mod._configured = False


def test_resolve_log_level_uses_env(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")

    assert resolve_log_level() == logging.DEBUG


def test_resolve_log_level_falls_back_for_invalid_value(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "NOT_A_LEVEL")

    assert resolve_log_level() == logging.INFO


def test_setup_logging_applies_expected_formatter(monkeypatch):
    _reset()
    monkeypatch.setenv("LOG_LEVEL", "WARNING")

    setup_logging()
    root = logging.getLogger()

    assert root.level == logging.WARNING
    assert len(root.handlers) == 1
    formatter = root.handlers[0].formatter
    assert formatter is not None
    assert formatter._fmt == '%(asctime)s - %(levelname)s - %(name)s - %(message)s'


def test_setup_logging_is_idempotent(monkeypatch):
    _reset()
    monkeypatch.setenv("LOG_LEVEL", "INFO")

    setup_logging()
    first_handler = logging.getLogger().handlers[0]

    setup_logging()  # second call should be a no-op
    assert logging.getLogger().handlers[0] is first_handler
