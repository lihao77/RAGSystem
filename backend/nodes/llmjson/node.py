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
                {"name": "file_ids", "type": "file_ids", "description": "文件ID列表（推荐，从文件管理系统选择）", "required": False, "multiple": True, "accept": ".txt,.md,.docx,.pdf"},
                {"name": "files", "type": "array", "description": "本地文件路径列表（注意：浏览器限制，仅支持后端运行）", "required": False, "multiple": True},
                {"name": "text", "type": "text", "description": "直接输入文本", "required": False}
            ],
            input_constraints={
                # file_ids/files/text 互斥，只能选一种输入方式
                "exclusive_groups": [
                    ["file_ids", "files", "text"]
                ],
                # 必须至少选一种输入方式
                "required_one_of": [
                    ["file_ids", "files", "text"]
                ]
            },
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

        # 验证LLM配置
        if not self._config.llm_config.get("provider"):
            errors.append("必须选择 LLM Provider")
        if not self._config.llm_config.get("model_name"):
            errors.append("必须选择或输入模型名称")

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

        # 从 Adapter 获取 Provider 配置
        try:
            from model_adapter.adapter import get_default_adapter
            adapter = get_default_adapter()

            # 获取 Provider 实例和配置
            provider_name = config.llm_config.get("provider")
            if not provider_name:
                return {
                    "json_data": {},
                    "entities": [],
                    "stats": {"error": "未选择 LLM Provider"}
                }

            provider = adapter.get_provider(provider_name)
            provider_config = adapter.get_provider_config(provider_name)

            # 使用 llm_config 中的参数（覆盖 provider 默认配置）
            model = config.llm_config.get("model_name") or provider_config.get("model")
            temperature = config.llm_config.get("temperature", provider_config.get("temperature", 0.7))
            max_tokens = config.llm_config.get("max_tokens", provider_config.get("max_tokens", 4096))
            timeout = config.llm_config.get("timeout", provider_config.get("timeout", 30))
            max_retries = config.llm_config.get("retry_attempts", provider_config.get("retry_attempts", 3))

            print(f"Using LLM Provider: {provider_name}, Model: {model}")
            print(f"Provider Endpoint: {provider.api_endpoint}")
            print(f"Provider API Key: {provider.api_key}")
            print(f"Config - Temperature: {temperature}, Max Tokens: {max_tokens}, Timeout: {timeout}, Max Retries: {max_retries}")
            # 初始化处理器（使用 Adapter 中的实际配置）
            processor = LLMProcessor(
                api_key=provider.api_key,
                base_url=provider.api_endpoint,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
                max_retries=max_retries,
                chunk_size=config.chunk_size,
                chunk_overlap=config.chunk_overlap,
                max_workers=config.max_workers,
                enable_parallel=config.enable_parallel,
                stream=True
            )

        except Exception as e:
            return {
                "json_data": {},
                "entities": [],
                "stats": {"error": f"从 Adapter 获取 Provider 配置失败: {str(e)}"}
            }
        
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
        
        # 处理文件（优先 file_ids，其次 files(路径)）
        files = inputs.get("files", [])
        file_ids = inputs.get("file_ids", [])
        if file_ids:
            try:
                from file_index import FileIndex
                idx = FileIndex()
                resolved = []
                for fid in file_ids:
                    rec = idx.get(str(fid))
                    if rec and rec.get('stored_path'):
                        resolved.append(rec['stored_path'])
                files = resolved or files
            except Exception:
                pass

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
