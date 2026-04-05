# -*- coding: utf-8 -*-

from pathlib import Path

from agents.config.manager import AgentConfigManager, DEFAULT_TEAM_NAME
from agents.config.models import AgentConfig


def _write_legacy_agent_config(config_dir: Path):
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / 'agent_configs.yaml').write_text(
        """
agents:
  orchestrator_agent:
    agent_name: orchestrator_agent
    display_name: Orchestrator
    enabled: true
    default_entry: true
    llm_tiers:
      default:
        provider: test
        model_name: model-a
metadata:
  version: '1.0'
""".strip() + "\n",
        encoding='utf-8',
    )


def test_manager_migrates_legacy_single_file_to_team_index(tmp_path):
    config_dir = tmp_path / 'agents'
    _write_legacy_agent_config(config_dir)

    manager = AgentConfigManager(config_dir=str(config_dir))

    assert manager.get_active_team() == DEFAULT_TEAM_NAME
    assert (config_dir / 'team_index.yaml').exists()
    assert (config_dir / 'teams' / 'default.yaml').exists()
    assert 'orchestrator_agent' in manager.get_all_configs()


def test_switch_active_team_loads_different_agent_sets(tmp_path):
    manager = AgentConfigManager(config_dir=str(tmp_path / 'agents'))
    manager.set_config(
        AgentConfig(
            agent_name='agent_a',
            enabled=True,
            llm_tiers={'default': {'provider': 'test', 'model_name': 'model-a'}},
        )
    )
    manager.create_team('research', source_team='default')
    manager.set_active_team('research')
    manager.delete_config('agent_a')
    manager.set_config(
        AgentConfig(
            agent_name='agent_b',
            enabled=True,
            llm_tiers={'default': {'provider': 'test', 'model_name': 'model-b'}},
        )
    )

    manager.set_active_team('default')
    assert set(manager.get_all_configs().keys()) == {'agent_a'}

    manager.set_active_team('research')
    assert set(manager.get_all_configs().keys()) == {'agent_b'}


def test_copy_agents_between_teams_creates_independent_snapshot(tmp_path):
    manager = AgentConfigManager(config_dir=str(tmp_path / 'agents'))
    manager.set_config(
        AgentConfig(
            agent_name='shared_agent',
            enabled=True,
            llm_tiers={'default': {'provider': 'test', 'model_name': 'model-a'}},
            description='from default',
        )
    )
    manager.create_team('custom')
    manager.copy_agents_between_teams('default', 'custom', ['shared_agent'])

    manager.set_active_team('custom')
    copied = manager.get_config('shared_agent')
    copied.description = 'custom only'
    manager.set_config(copied)

    manager.set_active_team('default')
    assert manager.get_config('shared_agent').description == 'from default'

    manager.set_active_team('custom')
    assert manager.get_config('shared_agent').description == 'custom only'
