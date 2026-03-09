"""
自定义异常类

定义智能体系统的异常层次结构。
"""


class AgentError(Exception):
    """智能体系统基础异常"""
    pass


class RetryableError(AgentError):
    """可重试错误（网络错误、超时、临时故障等）"""
    pass


class NonRetryableError(AgentError):
    """不可重试错误（参数错误、权限错误、业务逻辑错误等）"""
    pass


class ToolExecutionError(AgentError):
    """工具执行错误"""
    def __init__(self, tool_name: str, message: str, original_error: Exception = None):
        self.tool_name = tool_name
        self.original_error = original_error
        super().__init__(f"工具 {tool_name} 执行失败: {message}")


class LLMError(AgentError):
    """LLM 调用错误"""
    def __init__(self, provider: str, message: str, original_error: Exception = None):
        self.provider = provider
        self.original_error = original_error
        super().__init__(f"LLM ({provider}) 调用失败: {message}")


class ConfigurationError(NonRetryableError):
    """配置错误"""
    pass


class PermissionError(NonRetryableError):
    """权限错误"""
    def __init__(self, resource: str, action: str, message: str = None):
        self.resource = resource
        self.action = action
        msg = message or f"无权限执行操作: {action} on {resource}"
        super().__init__(msg)


class ValidationError(NonRetryableError):
    """参数验证错误"""
    pass


class RateLimitError(RetryableError):
    """速率限制错误"""
    def __init__(self, retry_after: int = None, message: str = None):
        self.retry_after = retry_after
        msg = message or f"速率限制，请 {retry_after or '稍后'} 秒后重试"
        super().__init__(msg)


class NetworkError(RetryableError):
    """网络错误"""
    pass


class TimeoutError(RetryableError):
    """超时错误"""
    pass
