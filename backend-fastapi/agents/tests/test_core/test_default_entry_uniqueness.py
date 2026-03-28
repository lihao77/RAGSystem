# -*- coding: utf-8 -*-

from types import SimpleNamespace

from agents.config.manager import AgentConfigManager


def _cfg(name, default_entry=False):
    return SimpleNamespace(agent_name=name, default_entry=default_entry)


def test_set_config_clears_previous_default_entry():
    manager = AgentConfigManager.__new__(AgentConfigManager)
    manager._configs = {
        'a': _cfg('a', default_entry=True),
        'b': _cfg('b', default_entry=False),
    }
    manager._save_configs = lambda: None

    manager.set_config(_cfg('b', default_entry=True), save=False)

    assert manager._configs['a'].default_entry is False
    assert manager._configs['b'].default_entry is True


def test_update_config_keeps_only_latest_default_entry():
    manager = AgentConfigManager.__new__(AgentConfigManager)
    manager._configs = {
        'a': _cfg('a', default_entry=True),
        'b': _cfg('b', default_entry=False),
    }
    manager._save_configs = lambda: None
    manager.get_config = lambda agent_name: manager._configs.get(agent_name)
    manager.set_config = AgentConfigManager.set_config.__get__(manager, AgentConfigManager)
    manager._clear_other_default_entries = AgentConfigManager._clear_other_default_entries.__get__(manager, AgentConfigManager)

    config_b = manager._configs['b']
    config_b.default_entry = True
    updated = manager.update_config('b', save=False)

    assert updated.default_entry is True
    assert manager._configs['a'].default_entry is False
    assert manager._configs['b'].default_entry is True
