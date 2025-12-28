# -*- coding: utf-8 -*-
"""
LLMJson v2 节点实现 - 使用内置模板
"""

import json
import os
from typing import Dict, Any, Type, List
from pathlib import Path

from nodes.base import INode, NodeDefinition
from .config import LLMJsonV2NodeConfig


class LLMJsonV2Node(INode):
    """LLMJson v2节点 - 使用内置模板"""
    
    @classmethod
    def get_definition(cls) -> NodeDefinition:
        return NodeDefinition(
            type="llmjson_v2",
            name="LLM JSON提取 v2",
            description="使用llmjson v2内置模板进行信息提取",
            category="process",
            version="2.0.0",
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
                {"name": "extracted_data", "type": "json", "description": "提取的结构化数据"},
                {"name": "entities", "type": "json", "description": "提取的实体列表"},
                {"name": "relations", "type": "json", "description": "提取的关系列表"},
                {"name": "stats", "type": "json", "description": "处理统计信息"}
            ],
            config_schema=LLMJsonV2NodeConfig.model_json_schema()
        )
    
    @classmethod
    def get_config_class(cls) -> Type[LLMJsonV2NodeConfig]:
        return LLMJsonV2NodeConfig
    
    def validate(self) -> List[str]:
        """验证配置"""
        errors = super().validate()
        if self._config and not self._config.api_key:
            errors.append("API密钥不能为空")
        return errors
    
    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行节点"""
        try:
            # 导入llmjson
            import sys
            llmjson_path = self._get_llmjson_path()
            if llmjson_path not in sys.path:
                sys.path.insert(0, llmjson_path)
            
            from llmjson import ProcessorFactory
            from llmjson.word_chunker import WordChunker
        except ImportError as e:
            return {
                "extracted_data": {},
                "entities": [],
                "relations": [],
                "stats": {"error": f"llmjson v2 未安装: {str(e)}"}
            }
        
        config = self._config
        
        try:
            # 1. 设置环境变量
            self._setup_environment(config)
            
            # 2. 创建处理器配置
            processor_config = self._create_processor_config(config)
            
            # 3. 创建处理器
            processor = ProcessorFactory.create_from_config(processor_config)
            
            # 4. 创建分块器
            chunker = WordChunker(
                max_tokens=config.chunk_size,
                overlap_tokens=200
            )
            
            # 5. 处理输入数据
            all_results = []
            stats = {
                "files_processed": 0,
                "chunks_processed": 0,
                "successful_chunks": 0,
                "failed_chunks": 0,
                "errors": []
            }
            
            # 处理文件
            files = self._get_input_files(inputs)
            for file_path in files:
                try:
                    file_results = self._process_file(file_path, processor, chunker, stats)
                    all_results.extend(file_results)
                    stats["files_processed"] += 1
                except Exception as e:
                    stats["errors"].append({
                        "file": str(file_path),
                        "error": str(e)
                    })
            
            # 处理直接输入的文本
            text = inputs.get("text")
            if text:
                try:
                    text_results = self._process_text(text, processor, "direct_input", stats)
                    all_results.extend(text_results)
                except Exception as e:
                    stats["errors"].append({
                        "source": "direct_text",
                        "error": str(e)
                    })
            
            # 6. 聚合结果
            aggregated_data = self._aggregate_results(all_results)
            
            # 7. 提取实体和关系
            entities, relations = self._extract_entities_relations(aggregated_data)
            
            # 更新统计信息
            stats["total_entities"] = len(entities)
            stats["total_relations"] = len(relations)
            stats["success_rate"] = (
                stats["successful_chunks"] / max(stats["chunks_processed"], 1) * 100
            )
            
            return {
                "extracted_data": aggregated_data,
                "entities": entities,
                "relations": relations,
                "stats": stats
            }
            
        except Exception as e:
            return {
                "extracted_data": {},
                "entities": [],
                "relations": [],
                "stats": {
                    "error": f"处理失败: {str(e)}",
                    "error_type": "general_error"
                }
            }
    
    def _setup_environment(self, config):
        """设置环境变量"""
        os.environ['OPENAI_API_KEY'] = config.api_key
        os.environ['OPENAI_BASE_URL'] = config.base_url
        os.environ['OPENAI_MODEL'] = config.model
    
    def _get_template_path(self, template: str) -> str:
        """获取模板文件路径"""
        llmjson_path = self._get_llmjson_path()
        
        if template == "flood":
            template_file = "templates/flood_disaster.yaml"
        else:  # universal
            template_file = "templates/universal.yaml"
        
        template_path = os.path.join(llmjson_path, template_file)
        
        if not os.path.exists(template_path):
            raise FileNotFoundError(f"模板文件不存在: {template_path}")
        
        return template_path
    
    def _create_processor_config(self, config) -> Dict[str, Any]:
        """创建处理器配置 - 使用内置模板但自定义config"""
        # 获取模板路径
        template_path = self._get_template_path(config.template)
        
        # 创建处理器配置
        processor_config = {
            "template": {
                "config_path": template_path
            },
            "validator": {
                # 可以根据需要添加验证规则
            },
            "processor": {
                "api_key": config.api_key,
                "base_url": config.base_url,
                "model": config.model,
                "temperature": config.temperature,
                "max_tokens": config.max_tokens,
                "timeout": config.timeout,
                "max_retries": config.max_retries,
                "retry_delay": 1.0
            }
        }
        
        return processor_config
    
    def _get_llmjson_path(self) -> str:
        """获取llmjson包的路径"""
        import sys
        
        # 首先尝试从当前项目的llmjson目录
        current_dir = os.path.dirname(__file__)
        for i in range(5):  # 向上查找5级目录
            test_path = os.path.join(current_dir, '../' * i, 'llmjson')
            if os.path.exists(test_path) and os.path.exists(os.path.join(test_path, 'configs')):
                return os.path.abspath(test_path)
        
        # 如果项目目录没有，尝试从sys.path中找到llmjson包
        for path in sys.path:
            llmjson_path = os.path.join(path, 'llmjson')
            if os.path.exists(llmjson_path) and os.path.exists(os.path.join(llmjson_path, 'configs')):
                return llmjson_path
        
        raise FileNotFoundError("无法找到llmjson包目录")
    
    def _get_input_files(self, inputs: Dict[str, Any]) -> List[Path]:
        """获取输入文件列表"""
        files = []
        
        # 处理file_ids
        file_ids = inputs.get("file_ids", [])
        if file_ids:
            try:
                from file_index import FileIndex
                idx = FileIndex()
                for fid in file_ids:
                    rec = idx.get(str(fid))
                    if rec and rec.get('stored_path'):
                        files.append(Path(rec['stored_path']))
            except Exception:
                pass
        
        # 处理直接文件路径
        file_paths = inputs.get("files", [])
        for file_path in file_paths:
            files.append(Path(file_path))
        
        return files
    
    def _process_file(self, file_path: Path, processor, chunker, stats: Dict) -> List[Dict]:
        """处理单个文件"""
        results = []
        
        try:
            if file_path.suffix.lower() == '.docx':
                if self._config.include_tables:
                    chunks = chunker.chunk_document_with_tables(str(file_path))
                else:
                    chunks = chunker.chunk_document(str(file_path))
            else:
                with open(file_path, 'r', encoding=self._config.encoding) as f:
                    content = f.read()
                chunks = [content]
            
            for i, chunk in enumerate(chunks):
                chunk_results = self._process_text(
                    chunk, processor, f"{file_path.stem}_chunk_{i}", stats
                )
                results.extend(chunk_results)
                
        except Exception as e:
            stats["errors"].append({
                "file": str(file_path),
                "error": str(e)
            })
        
        return results
    
    def _process_text(self, text: str, processor, doc_name: str, stats: Dict) -> List[Dict]:
        """处理文本"""
        results = []
        stats["chunks_processed"] += 1
        
        try:
            result, info = processor.process_chunk(text, doc_name)
            
            if info.get('success') and result:
                results.append({
                    "data": result,
                    "metadata": {
                        "doc_name": doc_name,
                        "processing_info": info,
                        "chunk_length": len(text)
                    }
                })
                stats["successful_chunks"] += 1
            else:
                stats["failed_chunks"] += 1
                stats["errors"].append({
                    "doc_name": doc_name,
                    "error": info.get('error', 'Unknown error')
                })
                
        except Exception as e:
            stats["failed_chunks"] += 1
            stats["errors"].append({
                "doc_name": doc_name,
                "error": str(e)
            })
        
        return results
    
    def _aggregate_results(self, results: List[Dict]) -> Dict[str, Any]:
        """聚合处理结果"""
        all_data = {}
        
        for result in results:
            data = result["data"]
            doc_name = result["metadata"]["doc_name"]
            
            # 合并所有数据
            for key, value in data.items():
                if key not in all_data:
                    all_data[key] = []
                
                if isinstance(value, list):
                    # 为每个项目添加文档来源
                    for item in value:
                        if isinstance(item, dict):
                            item["文档来源"] = doc_name
                    all_data[key].extend(value)
        
        # 添加统计信息
        summary = {}
        for key, value in all_data.items():
            if isinstance(value, list):
                summary[f"{key}_count"] = len(value)
        
        all_data["summary"] = summary
        return all_data
    
    def _extract_entities_relations(self, aggregated_data: Dict) -> tuple:
        """从聚合数据中提取实体和关系"""
        entities = []
        relations = []
        
        # 通用模板格式
        if "entities" in aggregated_data:
            entities = aggregated_data.get("entities", [])
            relations = aggregated_data.get("relations", [])
        
        # 洪涝灾害模板格式
        elif "基础实体" in aggregated_data:
            # 合并基础实体和状态实体
            entities.extend(aggregated_data.get("基础实体", []))
            entities.extend(aggregated_data.get("状态实体", []))
            relations = aggregated_data.get("状态关系", [])
        
        return entities, relations