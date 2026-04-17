# -*- coding: utf-8 -*-
from pathlib import Path
from types import SimpleNamespace

from agents.config.loader import AgentLoader
from agents.implementations.orchestrator.agent import OrchestratorAgent
from tools.bootstrap import bootstrap_tool_system

bootstrap_tool_system()


class _DummyConfigManager:
    def __init__(self, configs):
        self._configs = configs

    def get_config(self, agent_name):
        return self._configs.get(agent_name)

    def get_all_configs(self):
        return dict(self._configs)


def _make_agent_config(agent_name: str, agent_type: str, enabled: bool = True, delegation=None):
    return SimpleNamespace(
        agent_name=agent_name,
        display_name=agent_name,
        description=f"{agent_name} desc",
        enabled=enabled,
        llm=SimpleNamespace(merge_with_default=lambda system_config, model_adapter=None: {}),
        llm_tiers={},
        tools=SimpleNamespace(enabled_tools=[]),
        skills=SimpleNamespace(enabled_skills=[], auto_inject=False),
        mcp=SimpleNamespace(enabled_servers=[]),
        delegation=SimpleNamespace(enabled_agents=list(delegation or [])),
        custom_params={'type': agent_type, 'behavior': {}},
    )


def test_loader_builds_orchestrator_via_unified_factory():
    configs = {
        'orchestrator_agent': _make_agent_config('orchestrator_agent', 'orchestrator', enabled=False),
    }
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(),
        config_manager=_DummyConfigManager(configs),
    )
    loader._resolve_tools_and_skills = lambda agent_config: ([], [])

    agents = loader.load_all_agents()

    assert 'orchestrator_agent' in agents
    assert isinstance(agents['orchestrator_agent'], OrchestratorAgent)


def test_loader_rejects_orchestrator_without_orchestrator_runtime():
    configs = {
        'orchestrator_agent': _make_agent_config('orchestrator_agent', 'orchestrator'),
    }
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=None,
        config_manager=_DummyConfigManager(configs),
    )
    loader._resolve_tools_and_skills = lambda agent_config: ([], [])

    agent = loader.load_agent(
        'orchestrator_agent',
        agent_config=configs['orchestrator_agent'],
        ignore_enabled=True,
    )

    assert agent is None


def test_loader_injects_call_agent_from_delegation_allowlist():
    configs = {
        'demo_agent': _make_agent_config('demo_agent', 'react', delegation=['chart_agent']),
    }
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(),
        config_manager=_DummyConfigManager(configs),
    )

    tools, skills = loader._resolve_tools_and_skills(configs['demo_agent'])
    names = [tool['function']['name'] for tool in tools]

    assert 'call_agent' in names
    assert 'send_message' in names
    assert 'request_user_input' in names
    assert skills == []


def test_loader_injects_orchestrator_runtime_into_all_orchestrator_agents():
    orchestrator_runtime = SimpleNamespace(name='runtime')
    configs = {
        'qa_agent': _make_agent_config('qa_agent', 'orchestrator', enabled=True),
    }
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=orchestrator_runtime,
        config_manager=_DummyConfigManager(configs),
    )
    loader._resolve_tools_and_skills = lambda agent_config: ([], [])

    agent = loader.load_agent('qa_agent', agent_config=configs['qa_agent'])

    assert isinstance(agent, OrchestratorAgent)
    assert agent.orchestrator is orchestrator_runtime


def test_loader_auto_includes_workspace_skills_for_entry_agent(tmp_path):
    workspace_root = tmp_path / 'workspace'
    skills_root = workspace_root / '.ragsystem' / 'skills' / 'workspace-skill'
    skills_root.mkdir(parents=True, exist_ok=True)
    (skills_root / 'SKILL.md').write_text(
        '---\nname: workspace-skill\ndescription: workspace only\n---\n\n# Workspace Skill\n',
        encoding='utf-8',
    )

    configs = {
        'entry_agent': _make_agent_config('entry_agent', 'react'),
    }
    configs['entry_agent'].custom_params['workspace_root'] = str(workspace_root)
    configs['entry_agent'].default_entry = True
    configs['entry_agent'].skills = SimpleNamespace(enabled_skills=[], auto_inject=True)

    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(get_default_entry_agent_name=lambda: 'entry_agent'),
        config_manager=_DummyConfigManager(configs),
    )

    tools, skills = loader._resolve_tools_and_skills(configs['entry_agent'])
    skill_names = [skill.name for skill in skills]
    tool_names = [tool['function']['name'] for tool in tools]

    assert 'workspace-skill' in skill_names
    assert 'activate_skill' in tool_names
    assert 'execute_skill_script' in tool_names


def test_loader_auto_includes_workspace_skills_for_explicit_default_entry_without_runtime_name(tmp_path):
    workspace_root = tmp_path / 'workspace'
    skills_root = workspace_root / '.ragsystem' / 'skills' / 'workspace-skill'
    skills_root.mkdir(parents=True, exist_ok=True)
    (skills_root / 'SKILL.md').write_text(
        '---\nname: workspace-skill\ndescription: workspace only\n---\n\n# Workspace Skill\n',
        encoding='utf-8',
    )

    configs = {
        'entry_agent': _make_agent_config('entry_agent', 'react'),
    }
    configs['entry_agent'].custom_params['workspace_root'] = str(workspace_root)
    configs['entry_agent'].default_entry = True
    configs['entry_agent'].skills = SimpleNamespace(enabled_skills=[], auto_inject=True)

    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(get_default_entry_agent_name=lambda: None),
        config_manager=_DummyConfigManager(configs),
    )

    tools, skills = loader._resolve_tools_and_skills(configs['entry_agent'])

    assert 'workspace-skill' in [skill.name for skill in skills]
    assert 'activate_skill' in [tool['function']['name'] for tool in tools]


def test_loader_non_entry_agent_excludes_workspace_skills_unless_enabled(tmp_path):
    workspace_root = tmp_path / 'workspace'
    skills_root = workspace_root / '.ragsystem' / 'skills' / 'workspace-skill'
    skills_root.mkdir(parents=True, exist_ok=True)
    (skills_root / 'SKILL.md').write_text(
        '---\nname: workspace-skill\ndescription: workspace only\n---\n\n# Workspace Skill\n',
        encoding='utf-8',
    )

    configs = {
        'worker_agent': _make_agent_config('worker_agent', 'react'),
    }
    configs['worker_agent'].custom_params['workspace_root'] = str(workspace_root)
    configs['worker_agent'].skills = SimpleNamespace(enabled_skills=[], auto_inject=True)

    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(get_default_entry_agent_name=lambda: 'entry_agent'),
        config_manager=_DummyConfigManager(configs),
    )

    tools, skills = loader._resolve_tools_and_skills(configs['worker_agent'])
    assert [skill.name for skill in skills] == []
    assert 'activate_skill' not in [tool['function']['name'] for tool in tools]

    configs['worker_agent'].skills = SimpleNamespace(enabled_skills=['workspace-skill'], auto_inject=True)
    tools, skills = loader._resolve_tools_and_skills(configs['worker_agent'])
    assert [skill.name for skill in skills] == ['workspace-skill']
    assert 'activate_skill' in [tool['function']['name'] for tool in tools]


def test_loader_requires_explicit_enable_for_user_global_skill(monkeypatch, tmp_path):
    global_root = tmp_path / 'global-skills'
    skill_root = global_root / 'global-skill'
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / 'SKILL.md').write_text(
        '---\nname: global-skill\ndescription: global only\n---\n\n# Global Skill\n',
        encoding='utf-8',
    )

    configs = {
        'entry_agent': _make_agent_config('entry_agent', 'react'),
    }
    configs['entry_agent'].skills = SimpleNamespace(enabled_skills=[], auto_inject=True)

    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(get_default_entry_agent_name=lambda: 'entry_agent'),
        config_manager=_DummyConfigManager(configs),
    )

    from agents.skills.skill_loader import SkillLoader
    test_loader = SkillLoader(skills_dir=tmp_path / 'builtin-empty')
    test_loader.add_skills_dir(str(global_root), source_type='user_global')
    monkeypatch.setattr('agents.skills.skill_loader.get_skill_loader', lambda: test_loader)

    tools, skills = loader._resolve_tools_and_skills(configs['entry_agent'])
    assert [skill.name for skill in skills] == []
    assert 'activate_skill' not in [tool['function']['name'] for tool in tools]

    configs['entry_agent'].skills = SimpleNamespace(enabled_skills=['global-skill'], auto_inject=True)
    tools, skills = loader._resolve_tools_and_skills(configs['entry_agent'])
    assert [skill.name for skill in skills] == ['global-skill']
    assert 'activate_skill' in [tool['function']['name'] for tool in tools]


def test_loader_does_not_inject_call_agent_without_delegation():
    configs = {
        'demo_agent': _make_agent_config('demo_agent', 'react', delegation=[]),
    }
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(),
        config_manager=_DummyConfigManager(configs),
    )

    tools, _ = loader._resolve_tools_and_skills(configs['demo_agent'])
    names = [tool['function']['name'] for tool in tools]

    assert 'call_agent' not in names
    assert 'send_message' not in names
    assert 'request_user_input' in names


def test_runtime_exposure_allows_skill_tools_for_entry_agent_with_workspace_skills(tmp_path):
    """验证 loader 注入 workspace skills 后，运行时 get_tool_exposure_decision 允许 skill tools。"""
    from tools.runtime.exposure import get_tool_exposure_decision

    workspace_root = tmp_path / 'workspace'
    skills_root = workspace_root / '.ragsystem' / 'skills' / 'ws-skill'
    skills_root.mkdir(parents=True, exist_ok=True)
    (skills_root / 'SKILL.md').write_text(
        '---\nname: ws-skill\ndescription: test\n---\n\n# WS Skill\n',
        encoding='utf-8',
    )

    config = _make_agent_config('entry_agent', 'react')
    config.custom_params['workspace_root'] = str(workspace_root)
    config.default_entry = True
    config.skills = SimpleNamespace(enabled_skills=[], auto_inject=True)

    # 未经 loader 处理前，enabled_skills 为空 → skill tools 应不可见
    decision_before = get_tool_exposure_decision('activate_skill', config)
    assert decision_before.visible is False

    # loader 处理后标记 _effective_skill_names → skill tools 应可见
    loader = AgentLoader(
        model_adapter=None,
        system_config=None,
        orchestrator=SimpleNamespace(get_default_entry_agent_name=lambda: 'entry_agent'),
        config_manager=_DummyConfigManager({'entry_agent': config}),
    )
    loader._resolve_tools_and_skills(config)

    assert hasattr(config, '_effective_skill_names')
    assert 'ws-skill' in config._effective_skill_names

    for tool_name in ('activate_skill', 'execute_skill_script', 'load_skill_resource', 'get_skill_info'):
        decision = get_tool_exposure_decision(tool_name, config)
        assert decision.visible is True, f"{tool_name} should be visible after loader stamps effective skills"

    # 非 entry agent 无 _effective_skill_names、enabled_skills 为空 → 仍不可见
    worker = _make_agent_config('worker', 'react')
    worker.skills = SimpleNamespace(enabled_skills=[], auto_inject=True)
    decision_worker = get_tool_exposure_decision('activate_skill', worker)
    assert decision_worker.visible is False
