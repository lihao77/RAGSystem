# -*- coding: utf-8 -*-
"""
LLMJson v2 节点实现 - 使用内置模板。
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Type

from integrations.errors import IntegrationError
from integrations.llmjson import LLMJsonIntegrationError, LLMJsonV2Adapter
from nodes.base import INode, NodeDefinition
from .config import LLMJsonV2NodeConfig


class LLMJsonV2Node(INode):
    """LLMJson v2 节点 - 使用内置模板。"""

    @classmethod
    def get_definition(cls) -> NodeDefinition:
        return NodeDefinition(
            type='llmjson_v2',
            name='LLM JSON提取 v2',
            description='使用llmjson v2内置模板进行信息提取',
            category='process',
            version='2.0.0',
            inputs=[
                {'name': 'file_ids', 'type': 'file_ids', 'description': '文件ID列表（推荐，从文件管理系统选择）', 'required': False, 'multiple': True, 'accept': '.txt,.md,.docx,.pdf'},
                {'name': 'files', 'type': 'array', 'description': '本地文件路径列表（注意：浏览器限制，仅支持后端运行）', 'required': False, 'multiple': True},
                {'name': 'text', 'type': 'text', 'description': '直接输入文本', 'required': False},
            ],
            input_constraints={
                'exclusive_groups': [
                    ['file_ids', 'files', 'text'],
                ],
                'required_one_of': [
                    ['file_ids', 'files', 'text'],
                ],
            },
            outputs=[
                {'name': 'extracted_data', 'type': 'json', 'description': '提取的结构化数据'},
                {'name': 'entities', 'type': 'json', 'description': '提取的实体列表'},
                {'name': 'relations', 'type': 'json', 'description': '提取的关系列表'},
                {'name': 'stats', 'type': 'json', 'description': '处理统计信息'},
            ],
            config_schema=LLMJsonV2NodeConfig.model_json_schema(),
        )

    @classmethod
    def get_config_class(cls) -> Type[LLMJsonV2NodeConfig]:
        return LLMJsonV2NodeConfig

    def validate(self) -> List[str]:
        """验证配置。"""
        errors = super().validate()
        if self._config and not self._config.api_key:
            errors.append('API密钥不能为空')
        return errors

    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行节点。"""
        config = self._config

        try:
            session = LLMJsonV2Adapter(config).create_session()
        except (IntegrationError, LLMJsonIntegrationError) as error:
            return {
                'extracted_data': {},
                'entities': [],
                'relations': [],
                'stats': {'error': str(error)},
            }

        try:
            all_results = []
            stats = {
                'files_processed': 0,
                'chunks_processed': 0,
                'successful_chunks': 0,
                'failed_chunks': 0,
                'errors': [],
            }

            files = self._get_input_files(inputs)
            for file_path in files:
                try:
                    file_results = self._process_file(file_path, session, stats)
                    all_results.extend(file_results)
                    stats['files_processed'] += 1
                except Exception as error:
                    stats['errors'].append({
                        'file': str(file_path),
                        'error': str(error),
                    })

            text = inputs.get('text')
            if text:
                try:
                    text_results = self._process_text(text, session, 'direct_input', stats)
                    all_results.extend(text_results)
                except Exception as error:
                    stats['errors'].append({
                        'source': 'direct_text',
                        'error': str(error),
                    })

            aggregated_data = self._aggregate_results(all_results)
            entities, relations = self._extract_entities_relations(aggregated_data)

            stats['total_entities'] = len(entities)
            stats['total_relations'] = len(relations)
            stats['success_rate'] = stats['successful_chunks'] / max(stats['chunks_processed'], 1) * 100

            return {
                'extracted_data': aggregated_data,
                'entities': entities,
                'relations': relations,
                'stats': stats,
            }

        except Exception as error:
            return {
                'extracted_data': {},
                'entities': [],
                'relations': [],
                'stats': {
                    'error': f'处理失败: {error}',
                    'error_type': 'general_error',
                },
            }

    def _get_input_files(self, inputs: Dict[str, Any]) -> List[Path]:
        """获取输入文件列表。"""
        files = []

        file_ids = inputs.get('file_ids', [])
        if file_ids:
            try:
                from file_index import FileIndex

                index = FileIndex()
                for file_id in file_ids:
                    record = index.get(str(file_id))
                    if record and record.get('stored_path'):
                        files.append(Path(record['stored_path']))
            except Exception:
                pass

        for file_path in inputs.get('files', []):
            files.append(Path(file_path))

        return files

    def _process_file(self, file_path: Path, session, stats: Dict[str, Any]) -> List[Dict[str, Any]]:
        """处理单个文件。"""
        results: List[Dict[str, Any]] = []

        try:
            if file_path.suffix.lower() == '.docx':
                chunks = session.chunk_document(str(file_path), include_tables=self._config.include_tables)
            else:
                with open(file_path, 'r', encoding=self._config.encoding) as file:
                    content = file.read()
                chunks = [content]

            for index, chunk in enumerate(chunks):
                chunk_results = self._process_text(chunk, session, f'{file_path.stem}_chunk_{index}', stats)
                results.extend(chunk_results)

        except Exception as error:
            stats['errors'].append({
                'file': str(file_path),
                'error': str(error),
            })

        return results

    def _process_text(self, text: str, session, doc_name: str, stats: Dict[str, Any]) -> List[Dict[str, Any]]:
        """处理文本。"""
        results = []
        stats['chunks_processed'] += 1

        try:
            result, info = session.process_chunk(text, doc_name)

            if info.get('success') and result:
                results.append({
                    'data': result,
                    'metadata': {
                        'doc_name': doc_name,
                        'processing_info': info,
                        'chunk_length': len(text),
                    },
                })
                stats['successful_chunks'] += 1
            else:
                stats['failed_chunks'] += 1
                stats['errors'].append({
                    'doc_name': doc_name,
                    'error': info.get('error', 'Unknown error'),
                })

        except Exception as error:
            stats['failed_chunks'] += 1
            stats['errors'].append({
                'doc_name': doc_name,
                'error': str(error),
            })

        return results

    def _aggregate_results(self, results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """聚合处理结果。"""
        all_data: Dict[str, Any] = {}

        for result in results:
            data = result['data']
            doc_name = result['metadata']['doc_name']

            for key, value in data.items():
                if key not in all_data:
                    all_data[key] = []

                if isinstance(value, list):
                    for item in value:
                        if isinstance(item, dict):
                            item['文档来源'] = doc_name
                    all_data[key].extend(value)

        summary = {}
        for key, value in all_data.items():
            if isinstance(value, list):
                summary[f'{key}_count'] = len(value)

        all_data['summary'] = summary
        return all_data

    def _extract_entities_relations(self, aggregated_data: Dict[str, Any]) -> tuple:
        """从聚合数据中提取实体和关系。"""
        entities = []
        relations = []

        if 'entities' in aggregated_data:
            entities = aggregated_data.get('entities', [])
            relations = aggregated_data.get('relations', [])
        elif '基础实体' in aggregated_data:
            entities.extend(aggregated_data.get('基础实体', []))
            entities.extend(aggregated_data.get('状态实体', []))
            relations = aggregated_data.get('状态关系', [])

        return entities, relations
