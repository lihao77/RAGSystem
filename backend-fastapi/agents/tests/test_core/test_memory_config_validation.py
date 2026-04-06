# -*- coding: utf-8 -*-

import pytest
from pydantic import ValidationError

from agents.config.models import AgentMemoryConfig


def test_agent_memory_config_accepts_write_and_archive_scopes_within_allowed_scopes():
    config = AgentMemoryConfig(
        allowed_scopes=['team', 'session'],
        write_scopes=['session'],
        archive_scopes=['session'],
    )

    assert config.allowed_scopes == ['team', 'session']
    assert config.write_scopes == ['session']
    assert config.archive_scopes == ['session']


def test_agent_memory_config_rejects_write_scopes_outside_allowed_scopes():
    with pytest.raises(ValidationError) as exc_info:
        AgentMemoryConfig(
            allowed_scopes=['team'],
            write_scopes=['session'],
            archive_scopes=[],
        )

    assert 'write_scopes 必须是 allowed_scopes 的子集' in str(exc_info.value)


def test_agent_memory_config_rejects_archive_scopes_outside_allowed_scopes():
    with pytest.raises(ValidationError) as exc_info:
        AgentMemoryConfig(
            allowed_scopes=['team'],
            write_scopes=[],
            archive_scopes=['session'],
        )

    assert 'archive_scopes 必须是 allowed_scopes 的子集' in str(exc_info.value)
