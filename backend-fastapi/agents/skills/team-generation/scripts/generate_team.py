#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""generate_team.py - 生成完整 team 协议。"""

import argparse
import json
import re
import sys
from copy import deepcopy


DEFAULT_LLM = {
    "provider": "dmx",
    "provider_type": "openai",
    "model_name": "gpt-5.4",
    "temperature": 0.2,
    "max_completion_tokens": 4096,
    "max_context_tokens": 128000,
    "extra_params": {},
}
DEFAULT_MEMORY = {
    "auto_inject": True,
    "allowed_scopes": ["project", "session", "agent", "workspace"],
    "write_scopes": ["session", "agent", "workspace"],
    "archive_scopes": ["session", "agent", "workspace"],
}
DEFAULT_AGENT_TOOLS = [
    "read_file",
    "write_file",
    "edit_file",
    "preview_data_structure",
]
DEFAULT_ORCHESTRATOR_TOOLS = DEFAULT_AGENT_TOOLS + ["execute_bash"]


def _fail(message: str):
    print(json.dumps({"success": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", (value or "").strip()).strip("-._")
    return normalized or "generated"


def _title_case_slug(value: str) -> str:
    parts = [part for part in re.split(r"[-_.]+", value) if part]
    return " ".join(part.capitalize() for part in parts) or value


def _build_system_prompt(*, team_goal: str, role_name: str, role_prompt: str, is_entry: bool) -> str:
    base = [
        f"你是{role_name}。",
        f"当前 team 的总体目标是：{team_goal}。",
    ]
    if role_prompt:
        base.append(role_prompt)
    else:
        base.append(f"你负责围绕“{team_goal}”完成与{role_name}相关的核心工作。")
    if is_entry:
        base.append("你是该 team 的默认入口 Agent，应先理解用户目标，再决定直接回答、调用工具或委派给其他角色。")
    else:
        base.append("你是该 team 内的专业执行 Agent，应聚焦本角色职责，直接产出可执行结果，不要扩展到无关范围。")
    base.append("输出要求：先给结论，再给必要说明；简洁、明确、可执行，不输出推理过程。")
    return "".join(base)


def _build_agent_config(team_goal: str, role: dict, index: int) -> tuple[str, dict]:
    role_name = (role.get("role") or role.get("display_name") or role.get("agent_name") or f"agent-{index + 1}").strip()
    agent_name = _slugify(role.get("agent_name") or f"{_slugify(role_name)}_agent")
    display_name = (role.get("display_name") or role_name).strip()
    responsibility = (role.get("responsibility") or role.get("description") or f"负责 {team_goal} 中与 {display_name} 相关的任务").strip()
    role_prompt = (role.get("system_prompt") or role.get("prompt") or role.get("instructions") or "").strip()
    is_entry = bool(role.get("is_entry") or role.get("default_entry") or index == 0)

    tools = role.get("tools")
    if not isinstance(tools, list):
        tools = DEFAULT_ORCHESTRATOR_TOOLS if is_entry else DEFAULT_AGENT_TOOLS
    skills = role.get("skills")
    if not isinstance(skills, list):
        skills = []
    enabled_agents = role.get("delegation")
    if not isinstance(enabled_agents, list):
        enabled_agents = []

    config = {
        "agent_name": agent_name,
        "display_name": display_name,
        "description": responsibility,
        "enabled": True,
        "default_entry": is_entry,
        "llm_tiers": {
            "default": deepcopy(DEFAULT_LLM),
        },
        "tools": {
            "enabled_tools": tools,
        },
        "skills": {
            "enabled_skills": skills,
            "auto_inject": True,
        },
        "mcp": {
            "enabled_servers": role.get("mcp_servers") or [],
        },
        "memory": deepcopy(DEFAULT_MEMORY),
        "delegation": {
            "enabled_agents": enabled_agents,
        },
        "custom_params": {
            "behavior": {
                "system_prompt": _build_system_prompt(
                    team_goal=team_goal,
                    role_name=display_name,
                    role_prompt=role_prompt,
                    is_entry=is_entry,
                ),
                "auto_execute_tools": True,
            },
            "type": "orchestrator",
        },
    }
    return agent_name, config


def _normalize_agents_payload(team_goal: str, payload: dict) -> dict:
    normalized = {}
    default_entries = []
    for index, (agent_name, config_payload) in enumerate(payload.items()):
        if not isinstance(config_payload, dict):
            _fail(f"智能体 '{agent_name}' 的配置必须是对象")
        config = deepcopy(config_payload)
        config.setdefault("agent_name", agent_name)
        config.setdefault("display_name", config.get("agent_name", agent_name))
        config.setdefault("description", f"负责 {team_goal} 中与 {config['display_name']} 相关的任务")
        behavior = config.setdefault("custom_params", {}).setdefault("behavior", {})
        behavior.setdefault(
            "system_prompt",
            _build_system_prompt(
                team_goal=team_goal,
                role_name=config["display_name"],
                role_prompt=config.get("description", ""),
                is_entry=bool(config.get("default_entry", False)),
            ),
        )
        config.setdefault("enabled", True)
        config.setdefault("llm_tiers", {"default": deepcopy(DEFAULT_LLM)})
        config.setdefault("tools", {"enabled_tools": DEFAULT_ORCHESTRATOR_TOOLS if config.get("default_entry") else DEFAULT_AGENT_TOOLS})
        config.setdefault("skills", {"enabled_skills": [], "auto_inject": True})
        config.setdefault("mcp", {"enabled_servers": []})
        config.setdefault("memory", deepcopy(DEFAULT_MEMORY))
        config.setdefault("delegation", {"enabled_agents": []})
        config.setdefault("custom_params", {}).setdefault("type", "orchestrator")
        if config.get("default_entry"):
            default_entries.append(config["agent_name"])
        normalized[config["agent_name"]] = config

    if len(default_entries) > 1:
        _fail(f"default_entry=true 只能有一个，当前: {default_entries}")
    if not default_entries and normalized:
        first_key = next(iter(normalized.keys()))
        normalized[first_key]["default_entry"] = True
        normalized[first_key]["custom_params"]["behavior"]["system_prompt"] = _build_system_prompt(
            team_goal=team_goal,
            role_name=normalized[first_key]["display_name"],
            role_prompt=normalized[first_key]["description"],
            is_entry=True,
        )
    return normalized


def _build_roles_payload(team_goal: str, roles_payload: list) -> dict:
    if not isinstance(roles_payload, list) or not roles_payload:
        _fail("roles 必须是非空数组")
    normalized = {}
    for index, role in enumerate(roles_payload):
        if not isinstance(role, dict):
            _fail(f"roles[{index}] 必须是对象")
        agent_name, config = _build_agent_config(team_goal, role, index)
        normalized[agent_name] = config
    return normalized


def main():
    parser = argparse.ArgumentParser(description="生成 team payload 协议")
    parser.add_argument("--team-name", required=True, help="目标 team 名称")
    parser.add_argument("--team-goal", default="", help="team 的总体目标")
    parser.add_argument("--roles", default="", help="角色列表 JSON，每项包含 role/display_name/responsibility/system_prompt 等字段")
    parser.add_argument("--agents", default="", help="完整 agents payload 的 JSON 字符串；提供时优先使用")
    parser.add_argument("--source-team", default="", help="可选来源 team")
    parser.add_argument("--reason", default="", help="生成原因")
    args = parser.parse_args()

    team_name = (args.team_name or "").strip()
    if not team_name:
        _fail("team-name 不能为空")

    team_goal = (args.team_goal or args.reason or f"围绕 {team_name} 的协同任务").strip()
    source_team = (args.source_team or "").strip() or None
    reason = (args.reason or team_goal).strip()

    if args.agents:
        try:
            agents_payload = json.loads(args.agents)
        except json.JSONDecodeError as exc:
            _fail(f"agents 不是合法 JSON: {exc}")
        if not isinstance(agents_payload, dict) or not agents_payload:
            _fail("agents 必须是非空对象")
        agents_payload = _normalize_agents_payload(team_goal, agents_payload)
    elif args.roles:
        try:
            roles_payload = json.loads(args.roles)
        except json.JSONDecodeError as exc:
            _fail(f"roles 不是合法 JSON: {exc}")
        agents_payload = _build_roles_payload(team_goal, roles_payload)
    else:
        _fail("必须提供 --agents 或 --roles 其中之一")

    output = {
        "success": True,
        "summary": f"已生成 team payload: {team_name}",
        "data": {
            "team_name": team_name,
            "team_goal": team_goal,
            "reason": reason,
            "agent_count": len(agents_payload),
            "agents": [
                {
                    "agent_name": agent_name,
                    "display_name": config.get("display_name"),
                    "description": config.get("description"),
                    "default_entry": bool(config.get("default_entry", False)),
                }
                for agent_name, config in agents_payload.items()
            ],
        },
        "team": {
            "action": "create_or_replace",
            "team_name": team_name,
            "source_team": source_team,
            "agents": agents_payload,
        },
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
