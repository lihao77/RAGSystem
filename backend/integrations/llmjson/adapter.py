# -*- coding: utf-8 -*-
"""
llmjson 集成适配器。

将 llmjson 的包发现、导入、模板路径解析与环境变量隔离收口到 integrations 层。
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from importlib import import_module, util as importlib_util
from pathlib import Path
from typing import Any, Iterator, Optional
import logging
import os
import sys

from config import get_config
from integrations.errors import DependencyNotAvailableError, IntegrationConfigurationError

logger = logging.getLogger(__name__)

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_ENV_KEYS = ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL')
_TEMPLATE_FILES = {
    'flood': 'templates/flood_disaster.yaml',
    'universal': 'templates/universal.yaml',
}
_MISSING = object()


class LLMJsonIntegrationError(DependencyNotAvailableError):
    """llmjson 集成异常。"""


@dataclass
class _LLMJsonRuntime:
    package_dir: Path
    package_parent: Path
    llm_processor_cls: Any
    processor_factory: Any
    word_chunker_cls: Any


class LLMJsonSession:
    """旧版 llmjson 处理会话。"""

    def __init__(self, adapter: 'LLMJsonAdapter', processor: Any, chunker: Any):
        self._adapter = adapter
        self._processor = processor
        self._chunker = chunker

    def chunk_document(self, file_path: str, include_tables: bool) -> list:
        with self._adapter.integration_context():
            if include_tables and hasattr(self._chunker, 'chunk_document_with_tables'):
                return self._chunker.chunk_document_with_tables(file_path)
            return self._chunker.chunk_document(file_path)

    def process_chunk(self, text: str, doc_name: str):
        with self._adapter.integration_context():
            return self._processor.process_chunk(text, doc_name)


class LLMJsonV2Session:
    """一次 llmjson v2 处理会话。"""

    def __init__(self, adapter: 'LLMJsonV2Adapter', processor: Any, chunker: Any):
        self._adapter = adapter
        self._processor = processor
        self._chunker = chunker

    def chunk_document(self, file_path: str, include_tables: bool) -> list:
        with self._adapter.integration_context():
            if include_tables:
                return self._chunker.chunk_document_with_tables(file_path)
            return self._chunker.chunk_document(file_path)

    def process_chunk(self, text: str, doc_name: str):
        with self._adapter.integration_context():
            return self._processor.process_chunk(text, doc_name)


class _BaseLLMJsonAdapter:
    def __init__(self):
        self._runtime: Optional[_LLMJsonRuntime] = None

    @contextmanager
    def integration_context(self) -> Iterator[None]:
        runtime = self._load_runtime()

        inserted = False
        package_parent = str(runtime.package_parent)
        if package_parent not in sys.path:
            sys.path.insert(0, package_parent)
            inserted = True

        try:
            self._apply_environment()
            yield
        finally:
            self._restore_environment()
            if inserted:
                try:
                    sys.path.remove(package_parent)
                except ValueError:
                    pass

    def _load_runtime(self) -> _LLMJsonRuntime:
        if self._runtime is not None:
            return self._runtime

        package_dir = self._resolve_package_dir()
        package_parent = package_dir.parent

        try:
            with self._temporary_sys_path(package_parent):
                llmjson_module = import_module('llmjson')
                word_chunker_cls = import_module('llmjson.word_chunker').WordChunker
        except Exception as error:
            raise LLMJsonIntegrationError(f'llmjson 未安装或不可用: {error}') from error

        self._runtime = _LLMJsonRuntime(
            package_dir=package_dir,
            package_parent=package_parent,
            llm_processor_cls=getattr(llmjson_module, 'LLMProcessor', None),
            processor_factory=getattr(llmjson_module, 'ProcessorFactory', None),
            word_chunker_cls=word_chunker_cls,
        )
        return self._runtime

    def _resolve_package_dir(self) -> Path:
        configured_path = self._get_configured_llmjson_path()
        if configured_path is not None:
            return configured_path

        spec = importlib_util.find_spec('llmjson')
        if spec is not None:
            if spec.submodule_search_locations:
                package_dir = Path(next(iter(spec.submodule_search_locations)))
            elif spec.origin:
                package_dir = Path(spec.origin).parent
            else:
                package_dir = None

            normalized = self._normalize_package_dir(package_dir) if package_dir else None
            if normalized is not None:
                return normalized

        for parent in [_BACKEND_ROOT, *_BACKEND_ROOT.parents[:4]]:
            normalized = self._normalize_package_dir(parent / 'llmjson')
            if normalized is not None:
                return normalized

        raise LLMJsonIntegrationError('无法定位 llmjson 包，请安装依赖或在 external_libs.llmjson.path 中配置路径')

    def _get_configured_llmjson_path(self) -> Optional[Path]:
        try:
            configured = get_config().external_libs.llmjson.get('path')
        except Exception:
            configured = None

        if not configured:
            return None

        candidate = Path(configured).expanduser()
        if not candidate.is_absolute():
            candidate = _BACKEND_ROOT / candidate

        normalized = self._normalize_package_dir(candidate)
        if normalized is None:
            raise IntegrationConfigurationError(f'llmjson 路径配置无效: {candidate}')
        return normalized

    @staticmethod
    def _normalize_package_dir(candidate: Optional[Path]) -> Optional[Path]:
        if candidate is None:
            return None

        candidate = candidate.resolve()
        if candidate.name != 'llmjson' and (candidate / 'llmjson').exists():
            candidate = (candidate / 'llmjson').resolve()

        init_file = candidate / '__init__.py'
        template_dir = candidate / 'templates'
        config_dir = candidate / 'configs'
        if candidate.exists() and candidate.is_dir() and (init_file.exists() or template_dir.exists() or config_dir.exists()):
            return candidate
        return None

    @staticmethod
    @contextmanager
    def _temporary_sys_path(path: Path) -> Iterator[None]:
        inserted = False
        path_str = str(path)
        if path_str not in sys.path:
            sys.path.insert(0, path_str)
            inserted = True
        try:
            yield
        finally:
            if inserted:
                try:
                    sys.path.remove(path_str)
                except ValueError:
                    pass

    def _apply_environment(self) -> None:
        self._previous_env = {}
        for key, value in self._environment_updates().items():
            self._previous_env[key] = os.environ.get(key, _MISSING)
            os.environ[key] = str(value)

    def _restore_environment(self) -> None:
        previous_env = getattr(self, '_previous_env', {})
        for key in previous_env:
            previous = previous_env.get(key, _MISSING)
            if previous is _MISSING:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous
        self._previous_env = {}

    def _environment_updates(self) -> dict:
        return {}


class LLMJsonAdapter(_BaseLLMJsonAdapter):
    """旧版 llmjson 适配器。"""

    def __init__(self, *, api_key: str, base_url: str, model: str, temperature: float, max_tokens: int, timeout: int, max_retries: int, chunk_size: int, chunk_overlap: int, max_workers: int, enable_parallel: bool):
        super().__init__()
        self._processor_options = {
            'api_key': api_key,
            'base_url': base_url,
            'model': model,
            'temperature': temperature,
            'max_tokens': max_tokens,
            'timeout': timeout,
            'max_retries': max_retries,
            'chunk_size': chunk_size,
            'chunk_overlap': chunk_overlap,
            'max_workers': max_workers,
            'enable_parallel': enable_parallel,
            'stream': True,
        }

    def create_session(self) -> LLMJsonSession:
        runtime = self._load_runtime()
        if runtime.llm_processor_cls is None:
            raise LLMJsonIntegrationError('当前 llmjson 版本未提供 LLMProcessor')

        with self.integration_context():
            processor = runtime.llm_processor_cls(**self._processor_options)
            chunker = runtime.word_chunker_cls(
                max_tokens=self._processor_options['chunk_size'],
                overlap_tokens=self._processor_options['chunk_overlap'],
            )

        return LLMJsonSession(self, processor, chunker)


class LLMJsonV2Adapter(_BaseLLMJsonAdapter):
    """llmjson v2 的内部适配器。"""

    def __init__(self, config):
        super().__init__()
        self._config = config

    def create_session(self) -> LLMJsonV2Session:
        runtime = self._load_runtime()
        if runtime.processor_factory is None:
            raise LLMJsonIntegrationError('当前 llmjson 版本未提供 ProcessorFactory')

        processor_config = self._build_processor_config(runtime.package_dir)

        with self.integration_context():
            processor = runtime.processor_factory.create_from_config(processor_config)
            chunker = runtime.word_chunker_cls(
                max_tokens=self._config.chunk_size,
                overlap_tokens=200,
            )

        return LLMJsonV2Session(self, processor, chunker)

    def _environment_updates(self) -> dict:
        return {
            'OPENAI_API_KEY': self._config.api_key,
            'OPENAI_BASE_URL': self._config.base_url,
            'OPENAI_MODEL': self._config.model,
        }

    def _build_processor_config(self, package_dir: Path) -> dict:
        template_path = package_dir / _TEMPLATE_FILES.get(self._config.template, _TEMPLATE_FILES['universal'])
        if not template_path.exists():
            raise LLMJsonIntegrationError(f'模板文件不存在: {template_path}')

        return {
            'template': {
                'config_path': str(template_path),
            },
            'validator': {},
            'processor': {
                'api_key': self._config.api_key,
                'base_url': self._config.base_url,
                'model': self._config.model,
                'temperature': self._config.temperature,
                'max_tokens': self._config.max_tokens,
                'timeout': self._config.timeout,
                'max_retries': self._config.max_retries,
                'retry_delay': 1.0,
            },
        }
