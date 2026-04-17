# -*- coding: utf-8 -*-
"""
Skill 环境管理器 - venv 直接放在 skill 目录下（.venv/）
"""

import os
import sys
import logging
import subprocess
from pathlib import Path
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)


class SkillEnvironment:
    """Skill 环境管理器"""

    def __init__(self, skill_dir: Path, isolation_mode: str = "venv"):
        self.skill_dir = skill_dir
        self.isolation_mode = isolation_mode
        self.venv_dir = skill_dir / ".venv"
        self.requirements_file = skill_dir / "requirements.txt"

    def ensure_environment(self) -> Tuple[bool, str]:
        if self.isolation_mode == "shared":
            return True, ""
        if self.isolation_mode == "venv":
            return self._ensure_venv()
        return False, f"未知的隔离模式: {self.isolation_mode}"

    def get_python_executable(self) -> str:
        if self.isolation_mode == "venv" and self.venv_dir.exists():
            if sys.platform == "win32":
                return str(self.venv_dir / "Scripts" / "python.exe")
            return str(self.venv_dir / "bin" / "python")
        return sys.executable

    def execute_script(self, script_path: Path, arguments: List[str] = None, timeout: int = 30) -> Dict:
        success, error_msg = self.ensure_environment()
        if not success:
            return {"stdout": "", "stderr": f"环境准备失败: {error_msg}", "return_code": 1}

        python_exec = self.get_python_executable()
        command = [python_exec, str(script_path)] + (arguments or [])
        logger.info(f"执行脚本: {command}")

        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        env['PYTHONUTF8'] = '1'
        from core.path_resolution import DATA_ROOT
        env['RAG_DATA_ROOT'] = str(DATA_ROOT.resolve())

        try:
            result = subprocess.run(
                command, capture_output=True, text=True, timeout=timeout,
                cwd=str(self.skill_dir), env=env, encoding='utf-8', errors='replace',
            )
            return {"stdout": result.stdout, "stderr": result.stderr, "return_code": result.returncode}
        except subprocess.TimeoutExpired:
            return {"stdout": "", "stderr": f"脚本执行超时（>{timeout}秒）", "return_code": 124}
        except Exception as e:
            logger.error(f"脚本执行失败: {e}", exc_info=True)
            return {"stdout": "", "stderr": str(e), "return_code": 1}

    def _ensure_venv(self) -> Tuple[bool, str]:
        if not self.requirements_file.exists():
            return True, ""

        if not self.venv_dir.exists():
            logger.info(f"创建虚拟环境: {self.venv_dir}")
            try:
                subprocess.run(
                    [sys.executable, "-m", "venv", str(self.venv_dir)],
                    check=True, capture_output=True, timeout=60,
                )
            except subprocess.CalledProcessError as e:
                return False, f"创建虚拟环境失败: {e.stderr.decode()}"
            except Exception as e:
                return False, f"创建虚拟环境失败: {e}"

        installed_marker = self.venv_dir / ".installed"
        requirements_mtime = self.requirements_file.stat().st_mtime
        if installed_marker.exists() and installed_marker.stat().st_mtime >= requirements_mtime:
            return True, ""

        logger.info(f"安装 Skill 依赖: {self.requirements_file}")
        pip_exec = str(self.venv_dir / ("Scripts/pip.exe" if sys.platform == "win32" else "bin/pip"))
        try:
            subprocess.run(
                [pip_exec, "install", "-r", str(self.requirements_file)],
                check=True, capture_output=True, timeout=300, text=True,
            )
            installed_marker.touch()
            return True, ""
        except subprocess.CalledProcessError as e:
            return False, f"安装依赖失败: {e.stderr}"
        except Exception as e:
            return False, f"安装依赖失败: {e}"

    def get_environment_info(self) -> Dict:
        return {
            "skill_dir": str(self.skill_dir),
            "isolation_mode": self.isolation_mode,
            "venv_dir": str(self.venv_dir),
            "venv_exists": self.venv_dir.exists(),
            "requirements_exists": self.requirements_file.exists(),
            "python_executable": self.get_python_executable(),
        }


def get_skill_environment(skill_dir: Path, isolation_mode: str = None) -> SkillEnvironment:
    if isolation_mode is None:
        try:
            from config import get_config
            isolation_mode = get_config().get("skills", {}).get("isolation_mode", "venv")
        except Exception:
            isolation_mode = "venv"
    return SkillEnvironment(skill_dir, isolation_mode)
