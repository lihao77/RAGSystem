# -*- coding: utf-8 -*-
"""Central registry for runtime config files and bootstrap behavior."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

import core.path_resolution as path_resolution


@dataclass(frozen=True)
class RuntimeConfigInitSpec:
    key: str
    path: Path
    mode: str
    example_path: Path | None = None
    hint: str = ""
    is_dir: bool = False

    def missing_message(self) -> str:
        location = f"  运行时路径：{self.path}"
        lines = [f"未找到 {self.path.name}。"]
        if self.example_path is not None:
            lines.append(f"  可从示例初始化：cp {self.example_path} {self.path}")
        if self.hint:
            lines.append(f"  {self.hint}")
        elif self.mode == "lazy":
            lines.append("  缺失时会在首次写入时自动创建。")
        elif self.mode == "managed":
            lines.append("  将由运行时管理器在需要时初始化。")
        lines.append(location)
        return "\n".join(lines)


def build_runtime_config_init_specs(
    config_root: Path | None = None,
    backend_root: Path | None = None,
) -> tuple[RuntimeConfigInitSpec, ...]:
    config_root = Path(config_root) if config_root is not None else path_resolution.CONFIG_ROOT
    backend_root = Path(backend_root) if backend_root is not None else path_resolution.BACKEND_ROOT

    return (
        RuntimeConfigInitSpec(
            key="app_config",
            path=config_root / "app" / "config.yaml",
            mode="seed_from_example",
            example_path=backend_root / "config" / "yaml" / "config.yaml.example",
            hint="启动时缺失会从示例复制。",
        ),
        RuntimeConfigInitSpec(
            key="providers",
            path=config_root / "model_adapter" / "providers.yaml",
            mode="seed_from_example",
            example_path=backend_root / "model_adapter" / "configs" / "providers.yaml.example",
            hint="启动时缺失会从示例复制；填入 API key 即可使用。",
        ),
        RuntimeConfigInitSpec(
            key="vectorizers",
            path=config_root / "vector_store" / "vectorizers.yaml",
            mode="lazy",
            hint="向量数据库初始化会跳过；缺失时会在首次保存向量化器时创建。",
        ),
        RuntimeConfigInitSpec(
            key="mcp_servers",
            path=config_root / "mcp" / "mcp_servers.yaml",
            mode="seed_from_example",
            example_path=backend_root / "mcp" / "configs" / "mcp_servers.yaml.example",
            hint="启动时缺失会从示例复制。",
        ),
        RuntimeConfigInitSpec(
            key="daemon",
            path=config_root / "daemon" / "daemon.yaml",
            mode="seed_from_example",
            example_path=backend_root / "config" / "yaml" / "daemon.yaml.example",
            hint="启动时缺失会从示例复制；默认 disabled。",
        ),
        RuntimeConfigInitSpec(
            key="agent_team_index",
            path=config_root / "agents" / "team_index.yaml",
            mode="managed",
            hint="由 AgentConfigManager 在启动时初始化默认 team。",
        ),
        RuntimeConfigInitSpec(
            key="agent_teams_dir",
            path=config_root / "agents" / "teams",
            mode="managed",
            hint="由 AgentConfigManager 管理 team 配置文件。",
            is_dir=True,
        ),
    )


def seed_runtime_config_files(
    specs: tuple[RuntimeConfigInitSpec, ...] | list[RuntimeConfigInitSpec],
) -> list[tuple[Path, Path]]:
    """Copy seedable runtime config files from example templates if missing.

    Directories are expected to exist (created by ``ensure_directories()``
    during bootstrap).
    """
    copied: list[tuple[Path, Path]] = []
    for spec in specs:
        if spec.mode != "seed_from_example" or spec.is_dir:
            continue
        if spec.path.exists():
            continue
        if spec.example_path is None or not spec.example_path.exists():
            continue
        shutil.copy2(spec.example_path, spec.path)
        copied.append((spec.example_path, spec.path))
    return copied
