# -*- coding: utf-8 -*-

from pathlib import Path

from config.health_check import ConfigHealthCheck


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
