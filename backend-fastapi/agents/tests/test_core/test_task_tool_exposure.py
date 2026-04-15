# -*- coding: utf-8 -*-

from types import SimpleNamespace

from tools.runtime.exposure import get_tool_exposure_decision, resolve_effective_tool_exposure


def _agent_config(*, enabled_tools=None, workflow=False, background=False):
    return SimpleNamespace(
        tools=SimpleNamespace(enabled_tools=list(enabled_tools or [])),
        skills=SimpleNamespace(enabled_skills=[], auto_inject=False),
        mcp=SimpleNamespace(enabled_servers=[]),
        delegation=SimpleNamespace(enabled_agents=[]),
        memory=SimpleNamespace(allowed_scopes=[], write_scopes=[], archive_scopes=[]),
        tasks=SimpleNamespace(workflow=workflow, background=background),
    )


def test_resolve_effective_tool_exposure_exposes_workflow_task_tools_from_tasks_config():
    exposure = resolve_effective_tool_exposure(_agent_config(workflow=True, background=False))

    assert set(exposure['task_workflow_tool_names']) == {'task_create', 'task_get', 'task_update', 'task_list'}
    assert exposure['task_background_tool_names'] == []
    assert set(exposure['task_tool_names']) == {'task_create', 'task_get', 'task_update', 'task_list'}
    assert 'task_create' not in exposure['direct_tool_names']


def test_resolve_effective_tool_exposure_exposes_background_task_tools_from_tasks_config():
    exposure = resolve_effective_tool_exposure(_agent_config(workflow=False, background=True))

    assert exposure['task_workflow_tool_names'] == []
    assert set(exposure['task_background_tool_names']) == {'task_stop'}
    assert set(exposure['task_tool_names']) == {'task_stop'}


def test_get_tool_exposure_decision_for_task_tools_uses_tasks_config():
    config = _agent_config(workflow=True, background=False)

    workflow_decision = get_tool_exposure_decision('task_create', config)
    background_decision = get_tool_exposure_decision('task_stop', config)

    assert workflow_decision.visible is True
    assert workflow_decision.source == 'task'
    assert workflow_decision.derived_from == ['tasks.workflow']

    assert background_decision.visible is False
    assert background_decision.source == 'task'


def test_task_tools_in_enabled_tools_do_not_reenter_direct_tool_exposure():
    exposure = resolve_effective_tool_exposure(_agent_config(enabled_tools=['task_create', 'read_file'], workflow=False, background=False))

    assert 'task_create' not in exposure['direct_tool_names']
