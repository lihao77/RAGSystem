# -*- coding: utf-8 -*-

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

if importlib.util.find_spec('fastapi') is None:
    fastapi_stub = ModuleType('fastapi')
    fastapi_stub.FastAPI = object
    sys.modules.setdefault('fastapi', fastapi_stub)

from agents.config.manager import AgentConfigManager, DEFAULT_TEAM_NAME
from agents.config.models import AgentConfig
from config.runtime_files import build_runtime_config_init_specs, seed_runtime_config_files
from core.path_resolution import CONFIG_ROOT


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


def test_seed_runtime_configs_does_not_create_legacy_agent_config(tmp_path):
    fake_config_root = tmp_path / 'config-root'
    fake_backend_root = tmp_path / 'backend-root'
    (fake_config_root / 'app').mkdir(parents=True, exist_ok=True)
    (fake_backend_root / 'config' / 'yaml').mkdir(parents=True, exist_ok=True)
    (fake_backend_root / 'config' / 'yaml' / 'config.yaml.example').write_text('app: {}\n', encoding='utf-8')

    specs = build_runtime_config_init_specs(config_root=fake_config_root, backend_root=fake_backend_root)
    seed_runtime_config_files(specs)

    assert not (fake_config_root / 'agents' / 'agent_configs.yaml').exists()
    assert (fake_config_root / 'app' / 'config.yaml').exists()


def test_seed_runtime_configs_uses_example_not_source_config(tmp_path):
    fake_config_root = tmp_path / 'config-root'
    fake_backend_root = tmp_path / 'backend-root'
    (fake_config_root / 'app').mkdir(parents=True, exist_ok=True)
    source_config_dir = fake_backend_root / 'config' / 'yaml'
    source_config_dir.mkdir(parents=True, exist_ok=True)
    (source_config_dir / 'config.yaml').write_text('app: source\n', encoding='utf-8')
    (source_config_dir / 'config.yaml.example').write_text('app: example\n', encoding='utf-8')

    specs = build_runtime_config_init_specs(config_root=fake_config_root, backend_root=fake_backend_root)
    seed_runtime_config_files(specs)

    assert (fake_config_root / 'app' / 'config.yaml').read_text(encoding='utf-8') == 'app: example\n'



def test_manager_initializes_default_team_with_system_agents(tmp_path):
    manager = AgentConfigManager(config_dir=str(tmp_path / 'agents'))

    configs = manager.get_all_configs()
    assert manager.get_active_team() == DEFAULT_TEAM_NAME
    assert set(configs.keys()) == {
        'orchestrator_agent',
        'team_maker',
        'plan_agent',
        'explor_agent',
        'general_agent',
        'review_agent',
        'test_agent',
    }
    assert configs['orchestrator_agent'].default_entry is True
    assert configs['team_maker'].default_entry is False
    assert configs['plan_agent'].default_entry is False
    assert configs['explor_agent'].default_entry is False
    assert configs['orchestrator_agent'].delegation.enabled_agents == [
        'team_maker',
        'plan_agent',
        'explor_agent',
        'general_agent',
        'review_agent',
        'test_agent',
    ]
    assert configs['team_maker'].skills.enabled_skills == ['team-generation']
    assert configs['team_maker'].llm_tiers['default'].provider in ('', None)
    assert configs['team_maker'].llm_tiers['default'].provider_type in ('', None)


def test_manager_migrates_legacy_single_file_to_team_index(tmp_path):
    config_dir = tmp_path / 'agents'
    _write_legacy_agent_config(config_dir)

    manager = AgentConfigManager(config_dir=str(config_dir))

    assert manager.get_active_team() == DEFAULT_TEAM_NAME
    assert (config_dir / 'team_index.yaml').exists()
    assert (config_dir / 'teams' / 'default.yaml').exists()
    assert 'orchestrator_agent' in manager.get_all_configs()


def test_manager_migrates_provider_type_only_tiers_to_system_default(tmp_path):
    config_dir = tmp_path / 'agents'
    team_dir = config_dir / 'teams'
    team_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / 'team_index.yaml').write_text(
        """
active_team: default
teams:
  default: teams/default.yaml
metadata:
  version: '2.0'
""".strip() + "\n",
        encoding='utf-8',
    )
    (team_dir / 'default.yaml').write_text(
        """
agents:
  agent_a:
    agent_name: agent_a
    enabled: true
    llm_tiers:
      default:
        provider: ''
        provider_type: openai
        model_name: ''
metadata:
  version: '2.0'
""".strip() + "\n",
        encoding='utf-8',
    )

    manager = AgentConfigManager(config_dir=str(config_dir))

    tier = manager.get_config('agent_a').llm_tiers['default']
    assert tier.provider in ('', None)
    assert tier.provider_type in ('', None)


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
    assert {'orchestrator_agent', 'team_maker', 'plan_agent', 'explor_agent', 'general_agent', 'review_agent', 'test_agent', 'agent_a'} <= set(manager.get_all_configs().keys())

    manager.set_active_team('research')
    assert {'orchestrator_agent', 'team_maker', 'plan_agent', 'explor_agent', 'general_agent', 'review_agent', 'test_agent', 'agent_b'} <= set(manager.get_all_configs().keys())


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


def test_apply_team_payload_creates_team_without_switching_active_team(tmp_path):
    manager = AgentConfigManager(config_dir=str(tmp_path / 'agents'))
    manager.set_config(
        AgentConfig(
            agent_name='orchestrator_agent',
            enabled=True,
            default_entry=True,
            llm_tiers={'default': {'provider': 'test', 'model_name': 'model-a'}},
        )
    )

    result = manager.apply_team_payload(
        team_name='generated-team',
        agents_payload={
            'planner_agent': {
                'enabled': True,
                'default_entry': True,
                'llm_tiers': {'default': {'provider': 'test', 'model_name': 'model-b'}},
            }
        },
        source_team='default',
    )

    assert manager.get_active_team() == DEFAULT_TEAM_NAME
    assert result['team_name'] == 'generated-team'
    assert result['agent_count'] == 1
    assert 'planner_agent' in manager.get_team_configs('generated-team')
    assert 'orchestrator_agent' in manager.get_all_configs()


def test_apply_team_payload_rejects_multiple_default_entries(tmp_path):
    manager = AgentConfigManager(config_dir=str(tmp_path / 'agents'))

    with pytest.raises(ValueError, match='default_entry=true 只能有一个'):
        manager.apply_team_payload(
            team_name='bad-team',
            agents_payload={
                'agent_a': {
                    'enabled': True,
                    'default_entry': True,
                    'llm_tiers': {'default': {'provider': 'test', 'model_name': 'model-a'}},
                },
                'agent_b': {
                    'enabled': True,
                    'default_entry': True,
                    'llm_tiers': {'default': {'provider': 'test', 'model_name': 'model-b'}},
                },
            },
        )
