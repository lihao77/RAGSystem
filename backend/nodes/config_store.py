# -*- coding: utf-8 -*-
"""
节点配置存储管理器
"""

from pathlib import Path
from typing import Dict, Any, Optional, List, Type
from pydantic import BaseModel
from datetime import datetime
import yaml
import uuid

from .base import NodeConfigBase, INode


class ConfigMetadata(BaseModel):
    """配置元信息"""
    id: str
    name: str
    node_type: str
    description: str = ""
    created_at: str
    updated_at: str
    tags: List[str] = []
    is_preset: bool = False


class NodeConfigStore:
    """节点配置存储管理器"""
    
    def __init__(self, base_dir: str = None):
        if base_dir is None:
            base_dir = Path(__file__).parent.parent / "node_configs"
        self.base_dir = Path(base_dir)
        self.instances_dir = self.base_dir / "instances"
        self.presets_dir = self.base_dir / "presets"
        
        self.instances_dir.mkdir(parents=True, exist_ok=True)
        self.presets_dir.mkdir(parents=True, exist_ok=True)
    
    def save_config(self, 
                    node_type: str, 
                    config: NodeConfigBase, 
                    name: str,
                    description: str = "",
                    tags: List[str] = None,
                    is_preset: bool = False,
                    overwrite: bool = False) -> str:
        """保存节点配置

        - 默认行为：同名会创建新文件（历史版本）
        - overwrite=True 时：若实例配置中存在同名配置，则覆盖更新原文件（不新建）
        """
        # 仅对实例配置做同名覆盖（preset 不覆盖，避免破坏模板）
        if (not is_preset) and overwrite:
            existing = self.find_instance_by_name(node_type, name)
            if existing:
                self._write_config_file(
                    file_path=existing["file_path"],
                    config_id=existing["metadata"].id,
                    node_type=node_type,
                    name=name,
                    description=description,
                    tags=tags or existing["metadata"].tags,
                    is_preset=False,
                    config=config,
                    created_at=existing["metadata"].created_at
                )
                return existing["metadata"].id

        config_id = str(uuid.uuid4())[:8]
        now = datetime.now().isoformat()

        # 确定保存路径
        target_dir = (self.presets_dir / node_type) if is_preset else self.instances_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        file_path = target_dir / f"{config_id}_{name}.yaml"

        self._write_config_file(
            file_path=file_path,
            config_id=config_id,
            node_type=node_type,
            name=name,
            description=description,
            tags=tags or [],
            is_preset=is_preset,
            config=config,
            created_at=now
        )

        return config_id
    
    def load_config(self, 
                    config_id: str, 
                    node_class: Type[INode]) -> Optional[NodeConfigBase]:
        """加载节点配置"""
        file_path = self._find_config_file(config_id)
        if not file_path:
            return None
        
        with open(file_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)
        
        config_class = node_class.get_config_class()
        return config_class(**data.get("config", {}))
    
    def load_config_with_metadata(self, config_id: str) -> Optional[Dict[str, Any]]:
        """加载配置及其元信息"""
        file_path = self._find_config_file(config_id)
        if not file_path:
            return None
        
        with open(file_path, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    
    def list_configs(self, 
                     node_type: str = None, 
                     include_presets: bool = True) -> List[ConfigMetadata]:
        """列出配置"""
        configs = []
        
        # 实例配置
        for f in self.instances_dir.glob("*.yaml"):
            metadata = self._load_metadata(f)
            if metadata and (node_type is None or metadata.node_type == node_type):
                configs.append(metadata)
        
        # 预设配置
        if include_presets:
            search_dir = self.presets_dir / node_type if node_type else self.presets_dir
            if search_dir.exists():
                for f in search_dir.rglob("*.yaml"):
                    metadata = self._load_metadata(f)
                    if metadata:
                        configs.append(metadata)
        
        return configs
    
    def delete_config(self, config_id: str) -> bool:
        """删除配置"""
        file_path = self._find_config_file(config_id)
        if file_path:
            file_path.unlink()
            return True
        return False

    def find_instance_by_name(self, node_type: str, name: str) -> Optional[Dict[str, Any]]:
        """按 node_type + name 查找实例配置（不含 preset）"""
        for f in self.instances_dir.glob(f"*_{name}.yaml"):
            metadata = self._load_metadata(f)
            if metadata and metadata.node_type == node_type and metadata.name == name:
                return {"metadata": metadata, "file_path": f}
        return None

    def _write_config_file(self,
                           file_path: Path,
                           config_id: str,
                           node_type: str,
                           name: str,
                           description: str,
                           tags: List[str],
                           is_preset: bool,
                           config: NodeConfigBase,
                           created_at: str):
        now = datetime.now().isoformat()
        metadata = {
            "id": config_id,
            "name": name,
            "node_type": node_type,
            "description": description,
            "created_at": created_at,
            "updated_at": now,
            "tags": tags or [],
            "is_preset": is_preset
        }

        full_config = {
            "_metadata": metadata,
            "config": config.model_dump()
        }

        with open(file_path, 'w', encoding='utf-8') as f:
            yaml.dump(full_config, f, allow_unicode=True, default_flow_style=False)
    
    def _find_config_file(self, config_id: str) -> Optional[Path]:
        """查找配置文件"""
        # 先搜索实例
        for f in self.instances_dir.glob(f"{config_id}_*.yaml"):
            return f
        # 再搜索预设
        for f in self.presets_dir.rglob(f"{config_id}_*.yaml"):
            return f
        return None
    
    def _load_metadata(self, file_path: Path) -> Optional[ConfigMetadata]:
        """加载配置元信息"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f)
            return ConfigMetadata(**data.get("_metadata", {}))
        except Exception:
            return None
