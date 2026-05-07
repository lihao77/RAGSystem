# -*- coding: utf-8 -*-

from utils.yaml_store import load_yaml_file


def test_system_config_schema_hides_vector_backend_and_marks_nullable():
    from config.models import AppConfig
    from config.schema import generate_config_schema

    schema = generate_config_schema(AppConfig)
    group_keys = {group['key'] for group in schema['groups']}

    assert 'vector_store' not in group_keys

    llm_fields = {
        field['key']: field
        for group in schema['groups']
        if group['key'] == 'llm'
        for field in group['fields']
    }
    assert llm_fields['reasoning_effort']['nullable'] is True
    assert llm_fields['reasoning_effort']['options'][0] == {'value': '', 'label': '未设置'}
    assert AppConfig(llm={'reasoning_effort': ''}).llm.reasoning_effort is None


def test_system_config_update_does_not_persist_env_or_redacted_values(monkeypatch, tmp_path):
    config_root = tmp_path / 'config-root'
    config_path = config_root / 'app' / 'config.yaml'
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        'llm:\n'
        '  model_name: file-model\n'
        '  api_key: SECRET\n',
        encoding='utf-8',
    )

    monkeypatch.setattr('core.path_resolution.CONFIG_ROOT', config_root)
    monkeypatch.setenv('LLM_MODEL_NAME', 'env-model')

    from config.base import ConfigManager, REDACTED_VALUE

    manager = ConfigManager()

    public_config = manager.get_config_dict(redact_sensitive=True)
    assert public_config['llm']['model_name'] == 'env-model'
    assert public_config['llm']['api_key'] == REDACTED_VALUE

    manager.update_config({
        'llm': {
            'model_name': 'env-model',
            'api_key': REDACTED_VALUE,
            'temperature': 1.2,
        },
    })

    saved = load_yaml_file(config_path, default_factory=dict)
    assert saved['llm']['model_name'] == 'file-model'
    assert saved['llm']['api_key'] == 'SECRET'
    assert saved['llm']['temperature'] == 1.2
