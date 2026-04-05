# -*- coding: utf-8 -*-
"""
配置健康检查

在应用启动时执行，确保必需配置存在且格式正确；警告仅打印不阻止启动。
"""

import sys
from pathlib import Path
from typing import List

from core.path_resolution import CONFIG_ROOT

# 路径：以 backend 为根（config/health_check.py -> backend）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent


class ConfigHealthCheck:
    """配置健康检查器"""

    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.providers_path = CONFIG_ROOT / "model_adapter" / "providers.yaml"
        self.providers_example_path = _BACKEND_ROOT / "model_adapter" / "configs" / "providers.yaml.example"
        self.app_config_path = CONFIG_ROOT / "app" / "config.yaml"
        self.app_config_example_path = _BACKEND_ROOT / "config" / "yaml" / "config.yaml.example"
        self.agent_configs_path = CONFIG_ROOT / "agents" / "agent_configs.yaml"
        self.mcp_servers_path = CONFIG_ROOT / "mcp" / "mcp_servers.yaml"
        self.vectorizers_path = _BACKEND_ROOT / "vector_store" / "config" / "vectorizers.yaml"

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
            if rel not in content:
                self.warnings.append(f"建议将敏感文件加入 .gitignore: {rel}")

    def check_required_configs(self) -> None:
        """检查关键运行时配置文件是否存在；providers.yaml 缺失时仅警告。"""
        if not self.providers_path.exists():
            self.warnings.append(
                f"未找到 {self.providers_path.name}，对话/向量等能力将不可用。\n"
                f"  运行时配置位置：{self.providers_path}\n"
                f"  方式一：复制示例后编辑 — cp {self.providers_example_path} {self.providers_path}\n"
                f"  方式二：启动后在前端「模型适配器」中添加 Provider，将自动创建该文件"
            )

        if not self.app_config_path.exists():
            self.warnings.append(
                f"未找到系统配置文件 config.yaml。\n"
                f"  运行时配置位置：{self.app_config_path}\n"
                f"  可从示例初始化：cp {self.app_config_example_path} {self.app_config_path}"
            )

        if not self.agent_configs_path.exists():
            self.warnings.append(
                f"未找到 Agent 配置文件：{self.agent_configs_path}；启动时可能回退为默认空 team 配置。"
            )

        if not self.mcp_servers_path.exists():
            self.warnings.append(
                f"未找到 MCP 配置文件：{self.mcp_servers_path}；MCP Server 列表将为空。"
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

    def run(self) -> bool:
        """
        执行所有检查。
        返回 True 表示可启动，False 表示存在严重错误应中止。
        """
        self.errors.clear()
        self.warnings.clear()
        print("正在检查配置...")

        self.check_gitignore()
        self.check_required_configs()
        self.check_hook_config()

        if not self.errors:
            self.check_config_validity()

        if self.errors:
            print("\n" + "=" * 60)
            print("配置检查未通过，请处理以下错误：\n")
            for err in self.errors:
                print(err)
            print("=" * 60 + "\n")
            return False

        if self.warnings:
            print("\n" + "=" * 60)
            print("配置检查通过，但有以下建议：\n")
            for w in self.warnings:
                print(w)
            print("=" * 60 + "\n")
        else:
            print("配置检查通过。\n")

        return True


def run_health_check() -> bool:
    """运行健康检查的便捷函数"""
    return ConfigHealthCheck().run()


if __name__ == "__main__":
    if not run_health_check():
        sys.exit(1)
