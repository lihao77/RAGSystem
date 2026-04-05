# -*- coding: utf-8 -*-

import json
import subprocess
import sys
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[2] / 'skills' / 'team-generation' / 'scripts' / 'generate_team.py'


def _run_script(*args):
    completed = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        check=True,
        capture_output=True,
        text=True,
        encoding='utf-8',
    )
    return json.loads(completed.stdout)


def test_generate_team_script_builds_full_agent_configs_from_roles():
    payload = _run_script(
        '--team-name', 'study-team',
        '--team-goal', '围绕专项学习答疑与规划提供协同支持',
        '--roles', json.dumps([
            {
                'role': '主编排教练',
                'agent_name': 'orchestrator_agent',
                'responsibility': '负责理解用户目标、路由任务并汇总答案',
                'is_entry': True,
                'delegation': ['planner_agent', 'qa_agent'],
            },
            {
                'role': '规划专家',
                'agent_name': 'planner_agent',
                'responsibility': '负责阶段计划、任务拆解与复盘安排',
            },
        ], ensure_ascii=False),
    )

    assert payload['success'] is True
    assert payload['data']['team_name'] == 'study-team'
    assert payload['data']['agent_count'] == 2
    agents = payload['team']['agents']
    assert agents['orchestrator_agent']['display_name'] == '主编排教练'
    assert agents['orchestrator_agent']['default_entry'] is True
    assert 'system_prompt' in agents['orchestrator_agent']['custom_params']['behavior']
    assert '围绕专项学习答疑与规划提供协同支持' in agents['orchestrator_agent']['custom_params']['behavior']['system_prompt']
    assert agents['planner_agent']['description'] == '负责阶段计划、任务拆解与复盘安排'


def test_generate_team_script_enriches_agents_mode_with_missing_prompt_fields():
    payload = _run_script(
        '--team-name', 'agents-team',
        '--team-goal', '用于自动补全 agent 配置',
        '--agents', json.dumps({
            'planner_agent': {
                'enabled': True,
                'llm_tiers': {
                    'default': {
                        'provider': 'test',
                        'model_name': 'model-a',
                    }
                },
            }
        }, ensure_ascii=False),
    )

    config = payload['team']['agents']['planner_agent']
    assert config['display_name'] == 'planner_agent'
    assert config['description'] == '负责 用于自动补全 agent 配置 中与 planner_agent 相关的任务'
    assert config['default_entry'] is True
    assert 'system_prompt' in config['custom_params']['behavior']
