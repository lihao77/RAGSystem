# -*- coding: utf-8 -*-
"""
配置健康检查

在应用启动时执行，确保必需配置存在且格式正确；警告仅打印不阻止启动。
"""

import sys
from pathlib import Path
from typing import List

# 路径：以 backend 为根（config/health_check.py -> backend）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _path(*parts: str) -> Path:
    return _BACKEND_ROOT.joinpath(*parts)


class ConfigHealthCheck:
    """配置健康检查器"""

    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []

    def check_gitignore(self) -> None:
        """检查敏感文件是否在 .gitignore 中（.gitignore 在仓库根）"""
        # 仓库根可能在 backend 的上一级
        gitignore = _BACKEND_ROOT.parent / ".gitignore"
        if not gitignore.exists():
            self.warnings.append("未找到 .gitignore（敏感配置文件建议加入 .gitignore）")
            return
        content = gitignore.read_text(encoding="utf-8", errors="replace")
        for rel in [
            "backend-fastapi/model_adapter/configs/providers.yaml",
            "backend-fastapi/agents/configs/agent_configs.yaml",
            "backend-fastapi/config/yaml/config.yaml",
        ]:
            if rel not in content:
                self.warnings.append(f"建议将敏感文件加入 .gitignore: {rel}")

    def check_required_configs(self) -> None:
        """检查配置文件；providers.yaml 缺失时仅警告，允许启动后在前端添加 Provider 并自动创建"""
        providers_path = _path("model_adapter", "configs", "providers.yaml")
        if not providers_path.exists():
            example = _path("model_adapter", "configs", "providers.yaml.example")
            self.warnings.append(
                f"未找到 {providers_path.name}，对话/向量等能力将不可用。\n"
                f"  方式一：复制示例后编辑 — cp {example} {providers_path}\n"
                f"  方式二：启动后在前端「模型适配器」中添加 Provider，将自动创建该文件"
            )

    def check_config_validity(self) -> None:
        """检查配置文件格式及跨配置一致性（仅当 providers.yaml 存在时）"""
        providers_path = _path("model_adapter", "configs", "providers.yaml")
        if not providers_path.exists():
            return
        try:
            from config.schemas import ConfigValidator
        except Exception as e:
            self.errors.append(f"加载配置校验模块失败: {e}")
            return
        try:
            validator = ConfigValidator()
            validator.load_all(
                providers_path=providers_path,
                vectorizers_path=_path("vector_store", "config", "vectorizers.yaml"),
            )
            self.warnings.extend(validator.validate())
        except FileNotFoundError as e:
            self.errors.append(str(e))
        except Exception as e:
            self.errors.append(f"配置校验失败: {e}")

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
