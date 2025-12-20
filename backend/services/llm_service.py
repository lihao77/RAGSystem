# -*- coding: utf-8 -*-
"""
LLM服务 - 封装LLM API调用
"""

import logging
import requests
from config import get_config

logger = logging.getLogger(__name__)


class LLMService:
    """LLM服务封装类"""
    
    def __init__(self):
        self.config = get_config()
        self.api_endpoint = self.config.llm.api_endpoint
        self.api_key = self.config.llm.api_key
        self.model_name = self.config.llm.model_name
        self.temperature = self.config.llm.temperature
        self.max_tokens = self.config.llm.max_tokens
    
    def chat_completion(self, messages, tools=None, temperature=None, max_tokens=None, **kwargs):
        """
        LLM聊天补全
        
        Args:
            messages: 消息列表
            tools: 工具定义列表（Function Calling）
            temperature: 温度参数
            max_tokens: 最大token数
            **kwargs: 其他参数
            
        Returns:
            API响应结果
        """
        try:
            payload = {
                "model": self.model_name,
                "messages": messages,
                "temperature": temperature or self.temperature,
                "max_tokens": max_tokens or self.max_tokens,
                **kwargs
            }
            
            if tools:
                payload["tools"] = tools
            
            response = requests.post(
                f"{self.api_endpoint}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                },
                json=payload,
                timeout=60
            )
            
            response.raise_for_status()
            return response.json()
            
        except requests.exceptions.Timeout:
            logger.error('LLM API调用超时')
            raise Exception('LLM服务超时，请稍后重试')
        except requests.exceptions.RequestException as e:
            logger.error(f'LLM API调用失败: {e}')
            raise Exception(f'LLM服务调用失败: {str(e)}')
    
    def generate_text(self, prompt, system_prompt=None, temperature=None, max_tokens=None):
        """
        生成文本（简化接口）
        
        Args:
            prompt: 用户提示词
            system_prompt: 系统提示词
            temperature: 温度参数
            max_tokens: 最大token数
            
        Returns:
            生成的文本内容
        """
        messages = []
        
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        
        messages.append({"role": "user", "content": prompt})
        
        try:
            result = self.chat_completion(
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens
            )
            return result['choices'][0]['message']['content']
        except Exception as e:
            logger.error(f'文本生成失败: {e}')
            raise


# 全局单例
_llm_service = None


def get_llm_service():
    """获取LLM服务单例"""
    global _llm_service
    if _llm_service is None:
        _llm_service = LLMService()
    return _llm_service
