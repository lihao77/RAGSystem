# -*- coding: utf-8 -*-
"""
Function Calling 服务层。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
import json
from typing import Any, Dict, Optional

from config import get_config
from tools.function_definitions import get_tool_by_name, get_tool_definitions
from tools.tool_executor import execute_tool


class FunctionCallServiceError(Exception):
    """Function Calling 业务异常。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class FunctionCallService:
    """封装工具清单、工具执行和两阶段 tool-calling 对话。"""

    def __init__(
        self,
        *,
        config_getter=None,
        tool_definitions_getter=None,
        tool_lookup=None,
        tool_executor=None,
        http_client=None,
    ):
        self._config_getter = config_getter or get_config
        self._tool_definitions_getter = tool_definitions_getter or get_tool_definitions
        self._tool_lookup = tool_lookup or get_tool_by_name
        self._tool_executor = tool_executor or execute_tool
        self._http_client = http_client

    def get_tools(self) -> Dict[str, Any]:
        tools = self._tool_definitions_getter()
        return {'tools': tools, 'count': len(tools)}

    def execute_tool_call(self, payload: Optional[Dict[str, Any]]):
        data = payload or {}
        tool_name = data.get('tool_name')
        arguments = data.get('arguments', {})
        if not tool_name:
            raise FunctionCallServiceError('缺少tool_name参数', status_code=400)
        if not self._tool_lookup(tool_name):
            raise FunctionCallServiceError(f'未知的工具: {tool_name}', status_code=400)
        return self._tool_executor(tool_name, arguments)

    def chat_with_tools(self, payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        data = payload or {}
        messages = data.get('messages', [])
        if not messages:
            raise FunctionCallServiceError('缺少messages参数', status_code=400)

        config = self._config_getter()
        api_endpoint = config.llm.api_endpoint
        api_key = config.llm.api_key
        model_name = config.llm.model_name
        tools = self._tool_definitions_getter()
        http_client = self._get_http_client()

        first_response = http_client.post(
            f'{api_endpoint}/chat/completions',
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            json={
                'model': model_name,
                'messages': messages,
                'tools': tools,
                'tool_choice': 'auto',
                'temperature': 0.3,
            },
            timeout=60,
        )
        if first_response.status_code != 200:
            raise FunctionCallServiceError(f'LLM API调用失败: {first_response.text}', status_code=500)

        first_payload = first_response.json()
        assistant_message = first_payload['choices'][0]['message']
        tool_calls = assistant_message.get('tool_calls', [])
        if not tool_calls:
            return {'answer': assistant_message.get('content', ''), 'tool_calls': []}

        tool_results = []
        returned_tool_calls = []
        for tool_call in tool_calls:
            tool_name = tool_call['function']['name']
            arguments = json.loads(tool_call['function']['arguments'])
            tool_call_id = tool_call['id']
            tool_result = self._tool_executor(tool_name, arguments)
            tool_results.append(
                {
                    'tool_call_id': tool_call_id,
                    'role': 'tool',
                    'name': tool_name,
                    'content': json.dumps(tool_result, ensure_ascii=False),
                }
            )
            returned_tool_calls.append(
                {
                    'name': tool_name,
                    'arguments': arguments,
                    'result': tool_result,
                }
            )

        messages = list(messages)
        messages.append(assistant_message)
        messages.extend(tool_results)

        final_response = http_client.post(
            f'{api_endpoint}/chat/completions',
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            json={
                'model': model_name,
                'messages': messages,
                'temperature': 0.7,
            },
            timeout=60,
        )
        if final_response.status_code != 200:
            raise FunctionCallServiceError(f'LLM API调用失败: {final_response.text}', status_code=500)

        final_payload = final_response.json()
        final_answer = final_payload['choices'][0]['message']['content']
        return {'answer': final_answer, 'tool_calls': returned_tool_calls}

    def _get_http_client(self):
        if self._http_client is not None:
            return self._http_client
        import requests
        return requests


_function_call_service: Optional[FunctionCallService] = None



def get_function_call_service() -> FunctionCallService:
    global _function_call_service
    return get_runtime_dependency(
        container_getter='get_function_call_service',
        fallback_name='function_call_service',
        fallback_factory=FunctionCallService,
        require_container=True,
        legacy_getter=lambda: _function_call_service,
        legacy_setter=lambda instance: globals().__setitem__('_function_call_service', instance),
    )
