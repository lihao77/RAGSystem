# -*- coding: utf-8 -*-
"""
LLMJson 节点实现
"""

from typing import Dict, Any, Type, List
from pathlib import Path

from nodes.base import INode, NodeDefinition
from .config import LLMJsonNodeConfig


class LLMJsonNode(INode):
    """LLMJson节点 - 文本到JSON结构化提取"""
    
    @classmethod
    def get_definition(cls) -> NodeDefinition:
        return NodeDefinition(
            type="llmjson",
            name="LLM JSON提取",
            description="使用大语言模型从文本/文档中提取结构化JSON数据",
            category="process",
            version="1.0.0",
            inputs=[
                {"name": "files", "type": "file", "description": "输入文件列表", "required": False, "multiple": True},
                {"name": "text", "type": "text", "description": "直接输入文本", "required": False}
            ],
            outputs=[
                {"name": "json_data", "type": "json", "description": "提取的JSON数据"},
                {"name": "entities", "type": "json", "description": "提取的实体列表"},
                {"name": "stats", "type": "json", "description": "处理统计信息"}
            ],
            config_schema=LLMJsonNodeConfig.model_json_schema()
        )
    
    @classmethod
    def get_config_class(cls) -> Type[LLMJsonNodeConfig]:
        return LLMJsonNodeConfig
    
    def validate(self) -> List[str]:
        """验证配置"""
        errors = super().validate()
        if self._config and not self._config.api_key:
            errors.append("API密钥不能为空")
        return errors
    
    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行节点
        
        Args:
            inputs: {
                "files": List[str] - 文件路径列表,
                "text": Optional[str] - 直接输入的文本
            }
        """
        # 延迟导入，避免启动时依赖问题
        try:
            from llmjson import LLMProcessor, WordChunker
        except ImportError:
            return {
                "json_data": {},
                "entities": [],
                "stats": {"error": "llmjson 包未安装，请运行: pip install llmjson"}
            }
        
        config = self._config
        
        # 初始化处理器
        processor = LLMProcessor(
            api_key=config.api_key,
            base_url=config.base_url,
            model=config.model,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            timeout=config.timeout,
            max_retries=config.max_retries,
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
            max_workers=config.max_workers,
            enable_parallel=config.enable_parallel
        )
        
        chunker = WordChunker(
            max_tokens=config.chunk_size,
            overlap_tokens=config.chunk_overlap
        )
        
        all_entities = []
        all_states = []
        all_relations = []
        stats = {
            "files_processed": 0,
            "chunks_processed": 0,
            "entities_extracted": 0,
            "errors": []
        }
        
        # 处理文件
        files = inputs.get("files", [])
        for file_path in files:
            try:
                path = Path(file_path)
                
                if path.suffix == '.docx':
                    chunks = chunker.chunk_document_with_tables(str(path))
                else:
                    with open(path, 'r', encoding=config.encoding) as f:
                        content = f.read()
                    chunks = [content]
                
                for i, chunk in enumerate(chunks):
                    result, info = processor.process_chunk(chunk, f"{path.stem}_chunk_{i}")
                    
                    if info.get('success'):
                        all_entities.extend(result.get("基础实体", []))
                        all_states.extend(result.get("状态实体", []))
                        all_relations.extend(result.get("状态关系", []))
                        stats["chunks_processed"] += 1
                    else:
                        stats["errors"].append({
                            "file": str(path),
                            "chunk": i,
                            "error": info.get('error')
                        })
                
                stats["files_processed"] += 1
                
            except Exception as e:
                stats["errors"].append({"file": file_path, "error": str(e)})
        
        # 处理直接输入的文本
        text = inputs.get("text")
        if text:
            try:
                result, info = processor.process_chunk(text, "direct_input")
                if info.get('success'):
                    all_entities.extend(result.get("基础实体", []))
                    all_states.extend(result.get("状态实体", []))
                    all_relations.extend(result.get("状态关系", []))
                    stats["chunks_processed"] += 1
            except Exception as e:
                stats["errors"].append({"source": "text", "error": str(e)})
        
        stats["entities_extracted"] = len(all_entities)
        
        json_data = {
            "基础实体": all_entities,
            "状态实体": all_states,
            "状态关系": all_relations
        }
        
        return {
            "json_data": json_data,
            "entities": all_entities,
            "stats": stats
        }
