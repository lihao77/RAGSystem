# -*- coding: utf-8 -*-
"""
Skill 环境管理器 - 依赖隔离方案

支持三种隔离策略：
1. venv - 虚拟环境隔离（推荐）
2. docker - 容器隔离（生产环境）
3. shared - 共享环境（开发测试）
"""

import os
import sys
import logging
import subprocess
import json
from pathlib import Path
from typing import Dict, Optional, List, Tuple

logger = logging.getLogger(__name__)


class SkillEnvironment:
    """Skill 环境管理器"""

    def __init__(self, skill_dir: Path, isolation_mode: str = "venv"):
        """
        初始化环境管理器

        Args:
            skill_dir: Skill 目录路径
            isolation_mode: 隔离模式 (venv/docker/shared)
        """
        self.skill_dir = skill_dir
        self.isolation_mode = isolation_mode
        self.venv_dir = skill_dir / ".venv"
        self.requirements_file = skill_dir / "requirements.txt"

    def ensure_environment(self) -> Tuple[bool, str]:
        """
        确保环境就绪（按需创建和安装依赖）

        Returns:
            (是否成功, 错误信息)
        """
        if self.isolation_mode == "shared":
            # 共享环境：假设依赖已安装
            return True, ""

        elif self.isolation_mode == "venv":
            return self._ensure_venv()

        elif self.isolation_mode == "docker":
            return self._ensure_docker()

        else:
            return False, f"未知的隔离模式: {self.isolation_mode}"

    def get_python_executable(self) -> str:
        """
        获取 Python 可执行文件路径

        Returns:
            Python 解释器路径
        """
        if self.isolation_mode == "venv" and self.venv_dir.exists():
            if sys.platform == "win32":
                return str(self.venv_dir / "Scripts" / "python.exe")
            else:
                return str(self.venv_dir / "bin" / "python")

        # 默认使用系统 Python
        return sys.executable

    def execute_script(
        self,
        script_path: Path,
        arguments: List[str] = None,
        timeout: int = 30
    ) -> Dict:
        """
        在隔离环境中执行脚本

        Args:
            script_path: 脚本路径
            arguments: 命令行参数
            timeout: 超时时间（秒）

        Returns:
            执行结果字典 {stdout, stderr, return_code}
        """
        # 确保环境就绪
        success, error_msg = self.ensure_environment()
        if not success:
            return {
                "stdout": "",
                "stderr": f"环境准备失败: {error_msg}",
                "return_code": 1
            }

        # 获取 Python 解释器
        python_exec = self.get_python_executable()

        # 构建命令
        script_args = arguments if arguments else []
        command = [python_exec, str(script_path)] + script_args

        logger.info(f"执行脚本: {command}")

        # 设置环境变量，强制 UTF-8 编码
        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'  # Python I/O 编码
        env['PYTHONUTF8'] = '1'            # Python 3.7+ 强制 UTF-8 模式

        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=str(self.skill_dir),  # 在 Skill 目录下执行
                env=env,                   # 使用修改后的环境变量
                encoding='utf-8',          # 显式指定输出编码
                errors='replace'           # 遇到无法解码的字符用 ? 替代
            )

            return {
                "stdout": result.stdout,
                "stderr": result.stderr,
                "return_code": result.returncode
            }

        except subprocess.TimeoutExpired:
            return {
                "stdout": "",
                "stderr": f"脚本执行超时（>{timeout}秒）",
                "return_code": 124
            }
        except Exception as e:
            logger.error(f"脚本执行失败: {e}", exc_info=True)
            return {
                "stdout": "",
                "stderr": str(e),
                "return_code": 1
            }

    def _ensure_venv(self) -> Tuple[bool, str]:
        """
        确保虚拟环境存在且依赖已安装

        Returns:
            (是否成功, 错误信息)
        """
        # 1. 检查是否已有虚拟环境
        if not self.venv_dir.exists():
            logger.info(f"创建虚拟环境: {self.venv_dir}")
            try:
                subprocess.run(
                    [sys.executable, "-m", "venv", str(self.venv_dir)],
                    check=True,
                    capture_output=True,
                    timeout=60
                )
            except subprocess.CalledProcessError as e:
                error_msg = f"创建虚拟环境失败: {e.stderr.decode()}"
                logger.error(error_msg)
                return False, error_msg
            except Exception as e:
                error_msg = f"创建虚拟环境失败: {str(e)}"
                logger.error(error_msg)
                return False, error_msg

        # 2. 检查是否有 requirements.txt
        if not self.requirements_file.exists():
            # 没有依赖文件，认为不需要额外依赖
            logger.info(f"Skill 无 requirements.txt，跳过依赖安装")
            return True, ""

        # 3. 检查是否需要安装依赖（通过记录文件判断）
        installed_marker = self.venv_dir / ".installed"
        requirements_mtime = self.requirements_file.stat().st_mtime

        if installed_marker.exists():
            marker_mtime = installed_marker.stat().st_mtime
            if marker_mtime >= requirements_mtime:
                # 依赖已安装且 requirements.txt 未更新
                logger.info(f"Skill 依赖已安装，跳过")
                return True, ""

        # 4. 安装依赖
        logger.info(f"安装 Skill 依赖: {self.requirements_file}")
        pip_exec = self._get_pip_executable()

        try:
            result = subprocess.run(
                [pip_exec, "install", "-r", str(self.requirements_file)],
                check=True,
                capture_output=True,
                timeout=300,  # 5分钟超时
                text=True
            )
            logger.info(f"依赖安装成功: {result.stdout}")

            # 创建标记文件
            installed_marker.touch()
            return True, ""

        except subprocess.CalledProcessError as e:
            error_msg = f"安装依赖失败: {e.stderr}"
            logger.error(error_msg)
            return False, error_msg
        except Exception as e:
            error_msg = f"安装依赖失败: {str(e)}"
            logger.error(error_msg)
            return False, error_msg

    def _get_pip_executable(self) -> str:
        """获取 pip 可执行文件路径"""
        if sys.platform == "win32":
            return str(self.venv_dir / "Scripts" / "pip.exe")
        else:
            return str(self.venv_dir / "bin" / "pip")

    def _ensure_docker(self) -> Tuple[bool, str]:
        """
        确保 Docker 容器环境就绪（预留接口）

        Returns:
            (是否成功, 错误信息)
        """
        # TODO: 实现 Docker 容器隔离
        return False, "Docker 隔离模式尚未实现"

    def get_environment_info(self) -> Dict:
        """
        获取环境信息（用于调试）

        Returns:
            环境信息字典
        """
        return {
            "skill_dir": str(self.skill_dir),
            "isolation_mode": self.isolation_mode,
            "venv_exists": self.venv_dir.exists(),
            "requirements_exists": self.requirements_file.exists(),
            "python_executable": self.get_python_executable()
        }


def get_skill_environment(
    skill_dir: Path,
    isolation_mode: str = None
) -> SkillEnvironment:
    """
    工厂函数：创建 SkillEnvironment 实例

    Args:
        skill_dir: Skill 目录
        isolation_mode: 隔离模式（None 表示使用系统配置）

    Returns:
        SkillEnvironment 实例
    """
    # 如果未指定，从系统配置读取
    if isolation_mode is None:
        try:
            from config import get_config
            config = get_config()
            isolation_mode = config.get("skills", {}).get("isolation_mode", "venv")
        except:
            isolation_mode = "venv"  # 默认使用虚拟环境

    return SkillEnvironment(skill_dir, isolation_mode)
