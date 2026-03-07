# -*- coding: utf-8 -*-
"""
LLMJson 节点实现。
"""

from pathlib import Path
from typing import Any, Dict, List, Type

from integrations.errors import IntegrationError
from integrations.llmjson import LLMJsonAdapter, LLMJsonIntegrationError
from model_adapter.adapter import get_default_adapter
from nodes.base import INode, NodeDefinition
from .config import LLMJsonNodeConfig


class LLMJsonNode(INode):
    """LLMJson 节点 - 文本到 JSON 结构化提取。"""

    @classmethod
    def get_definition(cls) -> NodeDefinition:
        return NodeDefinition(
            type='llmjson',
            name='LLM JSON提取',
            description='使用大语言模型从文本/文档中提取结构化JSON数据',
            category='process',
            version='1.0.0',
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
                {'name': 'json_data', 'type': 'json', 'description': '提取的JSON数据'},
                {'name': 'entities', 'type': 'json', 'description': '提取的实体列表'},
                {'name': 'stats', 'type': 'json', 'description': '处理统计信息'},
            ],
            config_schema=LLMJsonNodeConfig.model_json_schema(),
        )

    @classmethod
    def get_config_class(cls) -> Type[LLMJsonNodeConfig]:
        return LLMJsonNodeConfig

    def validate(self) -> List[str]:
        """验证配置。"""
        errors = super().validate()

        if not self._config.llm_config.get('provider'):
            errors.append('必须选择 LLM Provider')
        if not self._config.llm_config.get('model_name'):
            errors.append('必须选择或输入模型名称')

        return errors

    def execute(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """执行节点。"""
        config = self._config

        try:
            session = self._create_session(config)
        except (IntegrationError, LLMJsonIntegrationError) as error:
            return {
                'json_data': {},
                'entities': [],
                'stats': {'error': str(error)},
            }
        except Exception as error:
            return {
                'json_data': {},
                'entities': [],
                'stats': {'error': f'从 Adapter 获取 Provider 配置失败: {error}'},
            }

        all_entities = []
        all_states = []
        all_relations = []
        stats = {
            'files_processed': 0,
            'chunks_processed': 0,
            'entities_extracted': 0,
            'errors': [],
        }

        files = self._resolve_input_files(inputs)
        for file_path in files:
            try:
                path = Path(file_path)
                if path.suffix == '.docx':
                    chunks = session.chunk_document(str(path), include_tables=config.include_tables)
                else:
                    with open(path, 'r', encoding=config.encoding) as file:
                        chunks = [file.read()]

                for index, chunk in enumerate(chunks):
                    result, info = session.process_chunk(chunk, f'{path.stem}_chunk_{index}')
                    if info.get('success'):
                        all_entities.extend(result.get('基础实体', []))
                        all_states.extend(result.get('状态实体', []))
                        all_relations.extend(result.get('状态关系', []))
                        stats['chunks_processed'] += 1
                    else:
                        stats['errors'].append({
                            'file': str(path),
                            'chunk': index,
                            'error': info.get('error'),
                        })

                stats['files_processed'] += 1

            except Exception as error:
                stats['errors'].append({'file': file_path, 'error': str(error)})

        text = inputs.get('text')
        if text:
            try:
                result, info = session.process_chunk(text, 'direct_input')
                if info.get('success'):
                    all_entities.extend(result.get('基础实体', []))
                    all_states.extend(result.get('状态实体', []))
                    all_relations.extend(result.get('状态关系', []))
                    stats['chunks_processed'] += 1
            except Exception as error:
                stats['errors'].append({'source': 'text', 'error': str(error)})

        stats['entities_extracted'] = len(all_entities)

        json_data = {
            '基础实体': all_entities,
            '状态实体': all_states,
            '状态关系': all_relations,
        }

        return {
            'json_data': json_data,
            'entities': all_entities,
            'stats': stats,
        }

    def _create_session(self, config: LLMJsonNodeConfig):
        provider_name = config.llm_config.get('provider')
        if not provider_name:
            raise LLMJsonIntegrationError('未选择 LLM Provider')

        adapter = get_default_adapter()
        provider = adapter.get_provider(provider_name)
        provider_config = adapter.get_provider_config(provider_name)

        model = config.llm_config.get('model_name') or provider_config.get('model')
        temperature = config.llm_config.get('temperature', provider_config.get('temperature', 0.7))
        max_tokens = config.llm_config.get('max_tokens', provider_config.get('max_tokens', 4096))
        timeout = config.llm_config.get('timeout', provider_config.get('timeout', 30))
        max_retries = config.llm_config.get('retry_attempts', provider_config.get('retry_attempts', 3))

        return LLMJsonAdapter(
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
        ).create_session()

    def _resolve_input_files(self, inputs: Dict[str, Any]) -> List[str]:
        files = inputs.get('files', [])
        file_ids = inputs.get('file_ids', [])
        if file_ids:
            try:
                from file_index import FileIndex

                index = FileIndex()
                resolved = []
                for file_id in file_ids:
                    record = index.get(str(file_id))
                    if record and record.get('stored_path'):
                        resolved.append(record['stored_path'])
                files = resolved or files
            except Exception:
                pass
        return files
