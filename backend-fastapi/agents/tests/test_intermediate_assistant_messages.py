# -*- coding: utf-8 -*-
"""中间 assistant 消息持久化行为测试。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_BACKEND_FASTAPI_ROOT = Path(__file__).resolve().parents[2]
if str(_BACKEND_FASTAPI_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_FASTAPI_ROOT))

from agents.core.base import BaseAgent
from agents.core.context import AgentContext
from agents.core.models import AgentResponse
from agents.implementations.orchestrator.agent import OrchestratorAgent


class _FakePublisher:
    def __init__(self) -> None:
        self.react_messages = []

    def react_intermediate(self, role: str, content: str, round: int, msg_type: str) -> None:
        self.react_messages.append({
            'role': role,
            'content': content,
            'round': round,
            'msg_type': msg_type,
        })


class _TestAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__(
            name='test_agent',
            description='test agent',
        )

    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        raise NotImplementedError


class IntermediateAssistantMessagesTest(unittest.TestCase):
    def test_base_agent_publishes_full_response_for_non_final_round(self) -> None:
        agent = _TestAgent()
        agent._publisher = _FakePublisher()

        full_response = '<intent>先分析</intent><tools><tool name="demo">{}</tool></tools>'
        agent._on_assistant_message(
            intent='仅用于上下文存储的意图',
            actions=[{'tool': 'demo', 'arguments': {}}],
            full_response=full_response,
            final_answer='',
            rounds=2,
            state={'publisher': agent._publisher},
        )

        self.assertEqual(agent._publisher.react_messages, [{
            'role': 'assistant',
            'content': full_response,
            'round': 2,
            'msg_type': 'assistant_response',
        }])

    def test_base_agent_skips_intermediate_persist_for_final_answer(self) -> None:
        agent = _TestAgent()
        agent._publisher = _FakePublisher()

        agent._on_assistant_message(
            intent='分析',
            actions=[],
            full_response='<intent>分析</intent><answer>完成</answer>',
            final_answer='完成',
            rounds=1,
            state={'publisher': agent._publisher},
        )

        self.assertEqual(agent._publisher.react_messages, [])

    def test_orchestrator_agent_uses_full_response_not_intent_only(self) -> None:
        agent = OrchestratorAgent.__new__(OrchestratorAgent)
        agent._publisher = _FakePublisher()

        full_response = '<intent>旧逻辑只会写入这段 thought</intent><tools><tool name="delegate">{}</tool></tools>'
        OrchestratorAgent._on_assistant_message(
            agent,
            intent='旧逻辑只会写入这段 thought',
            actions=[{'tool': 'delegate', 'arguments': {}}],
            full_response=full_response,
            final_answer='',
            rounds=3,
            state={'publisher': agent._publisher},
        )

        self.assertEqual(agent._publisher.react_messages, [{
            'role': 'assistant',
            'content': full_response,
            'round': 3,
            'msg_type': 'assistant_response',
        }])


if __name__ == '__main__':
    unittest.main()
