# -*- coding: utf-8 -*-
"""
配置健康检查

在应用启动时执行，确保必需配置存在且格式正确；警告仅打印不阻止启动。
"""

import logging
import sys
from pathlib import Path
from typing import List

from core.path_resolution import CONFIG_ROOT
from config.runtime_files import build_runtime_config_init_specs

logger = logging.getLogger(__name__)

# 路径：以 backend 为根（config/health_check.py -> backend）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent


class ConfigHealthCheck:
    """配置健康检查器"""

    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.runtime_specs = {
            spec.key: spec
            for spec in build_runtime_config_init_specs(CONFIG_ROOT, _BACKEND_ROOT)
        }
        self.providers_path = self.runtime_specs["providers"].path
        self.providers_example_path = self.runtime_specs["providers"].example_path
        self.app_config_path = self.runtime_specs["app_config"].path
        self.app_config_example_path = self.runtime_specs["app_config"].example_path
        self.agent_team_index_path = self.runtime_specs["agent_team_index"].path
        self.agent_teams_dir = self.runtime_specs["agent_teams_dir"].path
        self.mcp_servers_path = self.runtime_specs["mcp_servers"].path
        self.vectorizers_path = self.runtime_specs["vectorizers"].path
        self.daemon_config_path = self.runtime_specs["daemon"].path

    def check_gitignore(self) -> None:
        """检查敏感文件是否在 .gitignore 中（.gitignore 在仓库根）"""
        gitignore = _BACKEND_ROOT.parent / ".gitignore"
        if not gitignore.exists():
            self.warnings.append("未找到 .gitignore（敏感配置文件建议加入 .gitignore）")
            return
        content = gitignore.read_text(encoding="utf-8", errors="replace")
        for rel in [
            "backend-fastapi/.env",
            ".ragsystem/config/",
        ]:
            if not self._gitignore_covers(content, rel):
                self.warnings.append(f"建议将敏感文件加入 .gitignore: {rel}")

    def _gitignore_covers(self, content: str, rel: str) -> bool:
        """Return True when rel or one of its parent directories is ignored."""
        target = rel.strip().replace("\\", "/").strip("/")
        if not target:
            return False
        patterns = set()
        for line in content.splitlines():
            pattern = line.strip()
            if not pattern or pattern.startswith("#") or pattern.startswith("!"):
                continue
            patterns.add(pattern.replace("\\", "/").strip("/"))

        if target in patterns:
            return True

        parts = target.split("/")
        for index in range(1, len(parts)):
            parent = "/".join(parts[:index])
            if parent in patterns:
                return True
        return False

    def check_required_configs(self) -> None:
        """检查关键运行时配置文件是否存在。"""
        required_specs = ("providers", "app_config", "agent_team_index", "mcp_servers")
        for key in required_specs:
            spec = self.runtime_specs[key]
            if not spec.path.exists():
                self.warnings.append(spec.missing_message())

        agent_teams_spec = self.runtime_specs["agent_teams_dir"]
        if not agent_teams_spec.path.exists() or not any(agent_teams_spec.path.glob("*.yaml")):
            self.warnings.append(
                f"未找到 Agent team 配置文件：{agent_teams_spec.path}/*.yaml；"
                f"{agent_teams_spec.hint}"
            )

    def check_config_validity(self) -> None:
        """检查配置文件格式及跨配置一致性（仅当 providers.yaml 存在时）"""
        if not self.providers_path.exists():
            return
        try:
            from config.schemas import ConfigValidator
        except Exception as e:
            self.errors.append(f"加载配置校验模块失败: {e}")
            return
        try:
            validator = ConfigValidator()
            validator.load_all(
                providers_path=self.providers_path,
                vectorizers_path=self.vectorizers_path,
            )
            self.warnings.extend(validator.validate())
        except FileNotFoundError as e:
            self.errors.append(str(e))
        except Exception as e:
            self.errors.append(f"配置校验失败: {e}")

    def check_hook_config(self) -> None:
        """检查系统配置中的 hooks 字段结构。"""
        if not self.app_config_path.exists():
            return
        try:
            from utils.yaml_store import load_yaml_file

            config_data = load_yaml_file(self.app_config_path, default_factory=dict) or {}
            hooks = config_data.get("hooks") or {}
            if hooks and not isinstance(hooks, dict):
                self.errors.append("config.yaml 中 hooks 必须是对象")
                return

            workspace_trust = hooks.get("workspace_trust") or {}
            if workspace_trust and not isinstance(workspace_trust, dict):
                self.errors.append("config.yaml 中 hooks.workspace_trust 必须是对象")
                return

            default_trust = workspace_trust.get("default", "trusted")
            if default_trust not in {"trusted", "untrusted"}:
                self.errors.append("config.yaml 中 hooks.workspace_trust.default 只能是 trusted 或 untrusted")

            rules = workspace_trust.get("rules") or []
            if rules and not isinstance(rules, list):
                self.errors.append("config.yaml 中 hooks.workspace_trust.rules 必须是数组")
                return

            for index, rule in enumerate(rules):
                if not isinstance(rule, dict):
                    self.errors.append(f"config.yaml 中 hooks.workspace_trust.rules[{index}] 必须是对象")
                    continue
                workspace_root_prefix = rule.get("workspace_root_prefix")
                trust = rule.get("trust")
                if not workspace_root_prefix:
                    self.errors.append(
                        f"config.yaml 中 hooks.workspace_trust.rules[{index}] 缺少 workspace_root_prefix"
                    )
                if trust not in {"trusted", "untrusted"}:
                    self.errors.append(
                        f"config.yaml 中 hooks.workspace_trust.rules[{index}].trust 只能是 trusted 或 untrusted"
                    )
        except Exception as e:
            self.errors.append(f"hooks 配置检查失败: {e}")

    def check_mcp_config(self) -> None:
        """检查 MCP server 配置结构与 transport 必填项。"""
        if not self.mcp_servers_path.exists():
            return
        try:
            from mcp.config import MCPServerConfig
            from utils.yaml_store import load_yaml_file

            raw = load_yaml_file(self.mcp_servers_path, default_factory=dict) or {}
            servers = raw.get("servers") or {}
            if not isinstance(servers, dict):
                self.errors.append("mcp_servers.yaml 中 servers 必须是对象")
                return

            for server_name, cfg in servers.items():
                if not isinstance(cfg, dict):
                    self.errors.append(f"MCP server '{server_name}' 配置必须是对象")
                    continue
                try:
                    server_data = dict(cfg)
                    server_data.pop("name", None)
                    server = MCPServerConfig(name=str(server_name), **server_data)
                except Exception as e:
                    self.errors.append(f"MCP server '{server_name}' 配置无效: {e}")
                    continue
                if server.transport == "stdio" and not server.command:
                    self.errors.append(f"MCP server '{server_name}' 使用 stdio transport 时必须配置 command")
                if server.transport in {"sse", "streamable_http"} and not server.url:
                    self.errors.append(f"MCP server '{server_name}' 使用 {server.transport} transport 时必须配置 url")
        except Exception as e:
            self.errors.append(f"MCP 配置检查失败: {e}")

    def check_daemon_config(self) -> None:
        """检查 daemon 配置结构，以及启用任务引用的 team 是否存在。"""
        if not self.daemon_config_path.exists():
            return
        try:
            from daemon.models import DaemonSystemConfig
            from daemon.utils import model_validate
            from utils.yaml_store import load_yaml_file

            raw = load_yaml_file(self.daemon_config_path, default_factory=dict) or {}
            config = model_validate(DaemonSystemConfig, raw)
            if not config.enabled:
                return

            known_teams = set()
            if self.agent_team_index_path.exists():
                index = load_yaml_file(self.agent_team_index_path, default_factory=dict) or {}
                teams = index.get("teams") or {}
                if isinstance(teams, dict):
                    known_teams.update(str(team_name) for team_name in teams.keys())

            if not known_teams:
                self.warnings.append("daemon 已启用，但未找到可用 Agent team 配置")
                return

            for agent in config.agents:
                if agent.enabled and agent.team_name not in known_teams:
                    self.warnings.append(
                        f"daemon agent 引用了不存在的 team: '{agent.team_name}'"
                    )
                for task in agent.cron_tasks:
                    if task.enabled and task.team_name not in known_teams:
                        self.warnings.append(
                            f"daemon cron 任务 '{task.task_id}' 引用了不存在的 team: '{task.team_name}'"
                        )
        except Exception as e:
            self.errors.append(f"daemon 配置检查失败: {e}")

    def run(self) -> bool:
        """
        执行所有检查。
        返回 True 表示可启动，False 表示存在严重错误应中止。
        """
        self.errors.clear()
        self.warnings.clear()
        logger.info("正在检查配置...")

        self.check_gitignore()
        self.check_required_configs()
        self.check_hook_config()
        self.check_mcp_config()
        self.check_daemon_config()

        if not self.errors:
            self.check_config_validity()

        if self.errors:
            logger.error("配置检查未通过，请处理以下错误:")
            for err in self.errors:
                logger.error("  %s", err)
            return False

        if self.warnings:
            logger.warning("配置检查通过，但有以下建议:")
            for w in self.warnings:
                logger.warning("  %s", w)
        else:
            logger.info("配置检查通过")

        return True


def run_health_check() -> bool:
    """运行健康检查的便捷函数"""
    return ConfigHealthCheck().run()


if __name__ == "__main__":
    if not run_health_check():
        sys.exit(1)
