import logging

from agents.core.base import BaseAgent
from agents.core.context import AgentContext
from agents.core.models import AgentResponse


class _TestAgent(BaseAgent):
    def execute(self, task: str, context: AgentContext) -> AgentResponse:
        return AgentResponse(success=True, agent_name=self.name)


def test_base_agent_uses_instance_logger_for_runtime_logs(caplog):
    agent = _TestAgent(name="demo", description="demo")
    context = AgentContext(session_id="session-1")

    caplog.set_level(logging.INFO)
    agent.before_execute("task", context)
    agent.after_execute("task", context, AgentResponse(success=True, execution_time=0.5, agent_name="demo"))

    records = [record for record in caplog.records if "开始执行任务" in record.message or "任务完成" in record.message]
    assert records
    assert all(record.name == "Agent.demo" for record in records)


def test_get_llm_config_logs_with_instance_logger(caplog):
    agent = _TestAgent(name="demo", description="demo")
    tier = type("Tier", (), {"merge_with_default": lambda self, system_config, model_adapter=None: {"model_name": "gpt-demo"}})()
    agent.agent_config = type("Cfg", (), {"llm_tiers": {"powerful": tier}, "custom_params": {}})()

    caplog.set_level(logging.DEBUG)
    agent.get_llm_config(task_type="powerful")

    assert any(record.name == "Agent.demo" and "使用 powerful 层级模型" in record.message for record in caplog.records)
