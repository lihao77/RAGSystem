# -*- coding: utf-8 -*-

from pathlib import Path
from types import SimpleNamespace

from config.health_check import ConfigHealthCheck
from config.schemas import ConfigValidator, ProviderConfig, ProvidersConfig, VectorizersConfig


def test_health_check_uses_config_root_for_providers_path(monkeypatch, tmp_path):
    fake_config_root = tmp_path / 'config-root'
    providers_path = fake_config_root / 'model_adapter' / 'providers.yaml'
    providers_path.parent.mkdir(parents=True, exist_ok=True)
    providers_path.write_text('providers: []\n', encoding='utf-8')

    monkeypatch.setattr('config.health_check.CONFIG_ROOT', fake_config_root)
    checker = ConfigHealthCheck()

    assert checker.providers_path == providers_path


def test_health_check_uses_config_root_for_app_config_path(monkeypatch, tmp_path):
    fake_config_root = tmp_path / 'config-root'
    monkeypatch.setattr('config.health_check.CONFIG_ROOT', fake_config_root)
    checker = ConfigHealthCheck()

    assert checker.app_config_path == fake_config_root / 'app' / 'config.yaml'


def test_health_check_uses_config_root_for_vectorizers_path(monkeypatch, tmp_path):
    fake_config_root = tmp_path / 'config-root'
    monkeypatch.setattr('config.health_check.CONFIG_ROOT', fake_config_root)
    checker = ConfigHealthCheck()

    assert checker.vectorizers_path == fake_config_root / 'vector_store' / 'vectorizers.yaml'


def test_health_check_uses_config_root_for_agent_team_paths(monkeypatch, tmp_path):
    fake_config_root = tmp_path / 'config-root'
    monkeypatch.setattr('config.health_check.CONFIG_ROOT', fake_config_root)
    checker = ConfigHealthCheck()

    assert checker.agent_team_index_path == fake_config_root / 'agents' / 'team_index.yaml'
    assert checker.agent_teams_dir == fake_config_root / 'agents' / 'teams'


def test_health_check_warns_when_agent_team_configs_missing(monkeypatch, tmp_path):
    fake_config_root = tmp_path / 'config-root'
    monkeypatch.setattr('config.health_check.CONFIG_ROOT', fake_config_root)
    checker = ConfigHealthCheck()

    checker.check_required_configs()

    assert any('team_index.yaml' in warning for warning in checker.warnings)
    assert any('teams' in warning and '*.yaml' in warning for warning in checker.warnings)


def test_health_check_gitignore_accepts_ignored_parent_directory():
    checker = ConfigHealthCheck()

    assert checker._gitignore_covers('.ragsystem/\nbackend-fastapi/.env\n', '.ragsystem/config/')


def test_health_check_rejects_invalid_hooks_workspace_trust(monkeypatch, tmp_path):
    fake_config_root = tmp_path / 'config-root'
    app_config_path = fake_config_root / 'app' / 'config.yaml'
    app_config_path.parent.mkdir(parents=True, exist_ok=True)
    app_config_path.write_text(
        'hooks:\n  workspace_trust:\n    default: maybe\n',
        encoding='utf-8',
    )

    monkeypatch.setattr('config.health_check.CONFIG_ROOT', fake_config_root)
    checker = ConfigHealthCheck()
    checker.check_hook_config()

    assert any('hooks.workspace_trust.default' in err for err in checker.errors)


def test_config_validator_reports_provider_type_without_provider():
    validator = ConfigValidator()
    validator.providers = ProvidersConfig(
        providers={
            'demo_deepseek': ProviderConfig(
                name='demo',
                provider_type='deepseek',
                api_key='key',
                model_map={'chat': 'deepseek-chat'},
            )
        }
    )
    validator.vectorizers = VectorizersConfig()
    validator.agents = {
        'agent_a': SimpleNamespace(
            llm=None,
            llm_tiers={
                'default': SimpleNamespace(
                    provider='',
                    provider_type='openai',
                    model_name='',
                )
            },
        )
    }

    warnings = validator.validate()

    assert any('provider_type 但 provider 为空' in warning for warning in warnings)
    assert not any("'_openai'" in warning for warning in warnings)


def test_health_check_rejects_invalid_mcp_transport_requirements(monkeypatch, tmp_path):
    fake_config_root = tmp_path / 'config-root'
    mcp_path = fake_config_root / 'mcp' / 'mcp_servers.yaml'
    mcp_path.parent.mkdir(parents=True, exist_ok=True)
    mcp_path.write_text(
        'servers:\n  demo:\n    transport: stdio\n    enabled: true\n',
        encoding='utf-8',
    )

    monkeypatch.setattr('config.health_check.CONFIG_ROOT', fake_config_root)
    checker = ConfigHealthCheck()
    checker.check_mcp_config()

    assert any('stdio transport' in err and 'command' in err for err in checker.errors)
