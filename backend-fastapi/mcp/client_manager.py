# -*- coding: utf-8 -*-
"""
MCP Client Manager

管理所有 MCP Server 连接。使用后台 asyncio 事件循环线程桥接 MCP SDK 的异步 API
与 Flask 同步架构。
"""

import asyncio
import inspect
import logging
import threading
from typing import Any, Dict, List, Optional

from execution.observability import format_observability_for_log, get_current_execution_observability_fields
from runtime.dependencies import get_runtime_dependency

logger = logging.getLogger(__name__)


def _obs_suffix() -> str:
    suffix = format_observability_for_log(get_current_execution_observability_fields())
    return f' [{suffix}]' if suffix else ''


def _default_config_store_getter():
    from .config_store import get_mcp_config_store

    return get_mcp_config_store()


class MCPConnection:
    """单个 MCP Server 连接的状态"""

    def __init__(self, server_name: str, config: dict):
        self.server_name = server_name
        self.config = config
        self.status: str = "disconnected"  # disconnected / connecting / connected / error
        self.error_message: str = ""
        self.tools: list = []  # MCP Tool 对象列表
        # asyncio 资源（在事件循环线程中创建/使用）
        self._session = None           # mcp.ClientSession
        self._cm = None                # context manager
        self._read = None
        self._write = None

    def is_connected(self) -> bool:
        return self.status == "connected"


class MCPClientManager:
    """
    管理所有 MCP Server 连接（单例）

    异步适配方案：
    - 启动一个专用 daemon 线程，其中运行 asyncio 事件循环（永不退出）
    - Flask 同步代码通过 asyncio.run_coroutine_threadsafe() 向该循环提交协程
    - .result(timeout) 同步等待结果
    """

    def __init__(self, store=None, store_getter=None):
        self._connections: Dict[str, MCPConnection] = {}
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._started = False
        self._store = store
        self._store_getter = store_getter or _default_config_store_getter

    # ─── 生命周期 ────────────────────────────────────────────────────────────

    def startup(self):
        """启动后台事件循环线程，并自动连接已配置的 Server"""
        if self._started:
            return
        self._started = True

        # 创建并启动后台事件循环线程
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="mcp-event-loop",
            daemon=True
        )
        self._thread.start()
        logger.info("MCP 后台事件循环已启动")

        # 自动连接已启用的 Server
        self._auto_connect_all()

    def shutdown(self):
        """断开所有连接，停止事件循环"""
        if not self._started:
            return

        # 断开所有连接
        with self._lock:
            server_names = list(self._connections.keys())
        for name in server_names:
            try:
                self.disconnect_server(name)
            except Exception as e:
                logger.warning(f"断开 MCP Server {name} 时出错: {e}")

        # 停止事件循环
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=5)
        self._started = False
        logger.info("MCP 后台事件循环已停止")

    def _run_loop(self):
        """后台线程：运行 asyncio 事件循环直到被停止"""
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _run_async(self, coro, timeout: int = 30) -> Any:
        """
        在后台事件循环中运行协程，同步等待结果

        Args:
            coro: asyncio 协程
            timeout: 超时秒数

        Returns:
            协程返回值

        Raises:
            TimeoutError: 超时
            Exception: 协程内部异常
        """
        if not self._loop or not self._loop.is_running():
            raise RuntimeError("MCP 事件循环未启动，请先调用 startup()")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)


    def _get_store(self):
        if self._store is None:
            self._store = self._store_getter()
        return self._store

    # ─── 连接管理 ─────────────────────────────────────────────────────────────

    def _auto_connect_all(self):
        """自动连接所有 auto_connect=True 且 enabled=True 的 Server"""
        servers = self._get_store().list_servers()
        for srv_cfg in servers:
            if srv_cfg.get("enabled", True) and srv_cfg.get("auto_connect", True):
                name = srv_cfg.get("name") or srv_cfg.get("server_name")
                if name:
                    try:
                        self.connect_server(name)
                    except Exception as e:
                        logger.warning(f"自动连接 MCP Server {name} 失败: {e}")

    def connect_server(self, server_name: str) -> bool:
        """
        连接到指定的 MCP Server

        Args:
            server_name: Server 名称

        Returns:
            是否连接成功
        """
        srv_cfg = self._get_store().get_server(server_name)
        if srv_cfg is None:
            raise ValueError(f"MCP Server 配置不存在: {server_name}")

        if not srv_cfg.get("enabled", True):
            raise ValueError(f"MCP Server 已禁用: {server_name}")

        # 获取或创建连接对象
        with self._lock:
            if server_name not in self._connections:
                self._connections[server_name] = MCPConnection(server_name, srv_cfg)
            conn = self._connections[server_name]
            conn.config = srv_cfg

        if conn.is_connected():
            logger.info(f"MCP Server {server_name} 已连接，跳过{_obs_suffix()}")
            return True

        timeout = srv_cfg.get("timeout", 30)
        conn.status = "connecting"

        try:
            self._run_async(
                self._async_connect(conn, srv_cfg),
                timeout=timeout + 5
            )
            from tools.permissions import sync_mcp_tool_permissions

            sync_mcp_tool_permissions(
                server_name,
                conn.tools,
                risk_level=srv_cfg.get("risk_level", "medium"),
                requires_approval=srv_cfg.get("requires_approval", False)
            )
            logger.info(f"✓ MCP Server {server_name} 连接成功，发现 {len(conn.tools)} 个工具{_obs_suffix()}")
            return True
        except Exception as e:
            conn.status = "error"
            conn.error_message = self._format_exception_message(e)
            logger.exception("✗ MCP Server %s 连接失败: %s%s", server_name, conn.error_message, _obs_suffix())
            return False

    async def _async_connect(self, conn: MCPConnection, srv_cfg: dict):
        """异步连接 MCP Server 并发现工具"""
        try:
            transport = srv_cfg.get("transport", "stdio")

            if transport == "stdio":
                await self._connect_stdio(conn, srv_cfg)
            elif transport in ("sse", "streamable_http"):
                await self._connect_http(conn, srv_cfg)
            else:
                raise ValueError(f"不支持的传输方式: {transport}")

            # 发现工具
            response = await conn._session.list_tools()
            conn.tools = response.tools if hasattr(response, 'tools') else []
            conn.status = "connected"

        except Exception as e:
            conn.status = "error"
            conn.error_message = self._format_exception_message(e)
            raise

    async def _connect_stdio(self, conn: MCPConnection, srv_cfg: dict):
        """stdio 传输方式连接"""
        try:
            from mcp.client.session import ClientSession
            from mcp.client.stdio import stdio_client
        except ImportError as exc:
            sdk_error = None
            try:
                from mcp import get_mcp_sdk_import_error as _get_mcp_sdk_import_error
                sdk_error = _get_mcp_sdk_import_error()
            except Exception:
                sdk_error = None

            if sdk_error:
                raise ImportError(
                    f"未能导入 MCP SDK，请确认 pip 安装的 `mcp` 包可用且未被本地同名包遮蔽。原始错误: {sdk_error}"
                ) from exc

            raise ImportError(
                "未安装 MCP SDK，请运行: pip install mcp>=1.0.0"
            ) from exc

        import os
        command = srv_cfg.get("command")
        args = srv_cfg.get("args", [])
        env_extra = srv_cfg.get("env", {})

        if not command:
            raise ValueError(f"stdio 模式需要 command 配置")

        # 合并环境变量
        env = {**os.environ, **env_extra}

        from mcp.client.stdio import StdioServerParameters
        server_params = StdioServerParameters(
            command=command,
            args=args,
            env=env
        )

        # 注意：stdio_client 是 async context manager
        # 为了保持连接存活，我们需要保存 context manager
        cm = stdio_client(server_params)
        read, write = await cm.__aenter__()
        conn._cm = cm
        conn._read = read
        conn._write = write

        session = ClientSession(read, write)
        await session.__aenter__()
        conn._session = session
        await session.initialize()

    async def _connect_http(self, conn: MCPConnection, srv_cfg: dict):
        """SSE / streamable_http 传输方式连接"""
        try:
            from mcp.client.session import ClientSession
        except ImportError as exc:
            sdk_error = None
            try:
                from mcp import get_mcp_sdk_import_error as _get_mcp_sdk_import_error
                sdk_error = _get_mcp_sdk_import_error()
            except Exception:
                sdk_error = None

            if sdk_error:
                raise ImportError(
                    f"未能导入 MCP SDK，请确认 pip 安装的 `mcp` 包可用且未被本地同名包遮蔽。原始错误: {sdk_error}"
                ) from exc

            raise ImportError(
                "未安装 MCP SDK，请运行: pip install mcp>=1.0.0"
            ) from exc

        url = srv_cfg.get("url")
        headers = srv_cfg.get("headers", {}) or {}
        if not url:
            raise ValueError("SSE/HTTP 模式需要 url 配置")

        transport = srv_cfg.get("transport", "sse")

        if transport == "sse":
            try:
                from mcp.client.sse import sse_client
            except ImportError:
                raise ImportError("SSE 传输需要 mcp[sse] 依赖")
            kwargs = self._build_http_client_kwargs(sse_client, headers)
            cm = sse_client(url, **kwargs)
        else:
            try:
                from mcp.client.streamable_http import streamablehttp_client
            except ImportError:
                raise ImportError("streamable_http 传输需要 mcp[http] 依赖")
            kwargs = self._build_http_client_kwargs(streamablehttp_client, headers)
            cm = streamablehttp_client(url, **kwargs)

        read, write = self._extract_transport_streams(await cm.__aenter__())
        conn._cm = cm
        conn._read = read
        conn._write = write

        session = ClientSession(read, write)
        await session.__aenter__()
        conn._session = session
        await session.initialize()

    @staticmethod
    def _build_http_client_kwargs(client_factory, headers: dict) -> dict:
        if not headers:
            return {}

        try:
            signature = inspect.signature(client_factory)
        except (TypeError, ValueError):
            signature = None

        if signature and "headers" in signature.parameters:
            return {"headers": headers}

        raise ValueError("当前 MCP SDK 版本不支持为远程连接传递 headers")

    @staticmethod
    def _extract_transport_streams(transport_result):
        if not isinstance(transport_result, tuple):
            raise TypeError("MCP transport 返回值格式无效，应为 tuple")

        if len(transport_result) < 2:
            raise ValueError("MCP transport 返回值不完整，至少需要 read/write 两项")

        read, write = transport_result[:2]
        return read, write

    @staticmethod
    def _format_exception_message(error: Exception) -> str:
        primary = str(error).strip()
        if not primary:
            primary = error.__class__.__name__

        related = []
        for linked_error in (getattr(error, '__cause__', None), getattr(error, '__context__', None)):
            if linked_error is None:
                continue
            linked_message = str(linked_error).strip() or linked_error.__class__.__name__
            if linked_message and linked_message != primary and linked_message not in related:
                related.append(linked_message)

        if related:
            return f"{primary} | caused by: {' | '.join(related)}"
        return primary

    def disconnect_server(self, server_name: str):
        """Disconnect the specified MCP server."""
        from tools.permissions import unregister_mcp_tool_permissions

        with self._lock:
            conn = self._connections.get(server_name)
        if conn is None:
            unregister_mcp_tool_permissions(server_name)
            return

        try:
            self._run_async(self._async_disconnect(conn), timeout=10)
        except Exception as e:
            logger.warning(f"Error disconnecting MCP Server {server_name}: {e}{_obs_suffix()}")
        finally:
            conn.status = "disconnected"
            conn.tools = []
            conn.error_message = ""

        unregister_mcp_tool_permissions(server_name)

    def refresh_server(self, server_name: str) -> dict:
        """Refresh a server connection using the latest stored config."""
        srv_cfg = self._get_store().get_server(server_name)
        if srv_cfg is None:
            raise ValueError(f"MCP Server configuration not found: {server_name}")

        self.disconnect_server(server_name)

        if srv_cfg.get("enabled", True) and srv_cfg.get("auto_connect", True):
            self.connect_server(server_name)

        return self.get_server_status(server_name)

    async def _async_disconnect(self, conn: MCPConnection):
        """异步断开连接"""
        try:
            if conn._session:
                await conn._session.__aexit__(None, None, None)
                conn._session = None
        except Exception:
            pass
        try:
            if conn._cm:
                await conn._cm.__aexit__(None, None, None)
                conn._cm = None
        except Exception:
            pass

    # ─── 状态查询 ─────────────────────────────────────────────────────────────

    def get_server_status(self, server_name: str) -> dict:
        """获取 Server 连接状态"""
        with self._lock:
            conn = self._connections.get(server_name)
        if conn is None:
            return {
                "server_name": server_name,
                "status": "not_loaded",
                "tool_count": 0,
                "error_message": ""
            }
        return {
            "server_name": server_name,
            "status": conn.status,
            "tool_count": len(conn.tools),
            "error_message": conn.error_message
        }

    def get_all_statuses(self) -> Dict[str, dict]:
        """获取所有 Server 的连接状态"""
        with self._lock:
            names = list(self._connections.keys())
        return {name: self.get_server_status(name) for name in names}

    # ─── 工具发现 ─────────────────────────────────────────────────────────────

    def get_tools_openai_format(self, server_name: Optional[str] = None) -> List[dict]:
        """
        获取 OpenAI 格式的工具定义

        Args:
            server_name: 指定 Server；None 则返回所有已连接 Server 的工具

        Returns:
            OpenAI function calling 格式的工具列表
        """
        from .converter import mcp_tools_to_openai_format

        if server_name is not None:
            with self._lock:
                conn = self._connections.get(server_name)
            if conn is None or not conn.is_connected():
                logger.warning(f"MCP Server {server_name} 未连接，无法获取工具")
                return []
            return mcp_tools_to_openai_format(server_name, conn.tools)

        # 返回所有已连接 Server 的工具
        result = []
        with self._lock:
            connections = dict(self._connections)
        for name, conn in connections.items():
            if conn.is_connected():
                tools = mcp_tools_to_openai_format(name, conn.tools)
                result.extend(tools)
        return result

    # ─── 工具调用 ─────────────────────────────────────────────────────────────

    def call_tool(self, server_name: str, tool_name: str, arguments: dict) -> dict:
        """
        调用 MCP Server 的工具（同步包装异步）

        Args:
            server_name: Server 名称
            tool_name: 原始工具名（不含前缀）
            arguments: 工具参数

        Returns:
            标准化的工具响应字典
        """
        from tools.response_builder import success_response, error_response

        with self._lock:
            conn = self._connections.get(server_name)

        if conn is None or not conn.is_connected():
            return error_response(f"MCP Server '{server_name}' 未连接")

        # 获取 server 配置中的 timeout
        srv_cfg = self._get_store().get_server(server_name) or {}
        timeout = srv_cfg.get("timeout", 30)

        try:
            logger.info('MCP 工具调用开始 server=%s tool=%s %s', server_name, tool_name, format_observability_for_log())
            result = self._run_async(
                self._async_call_tool(conn, tool_name, arguments),
                timeout=timeout
            )
            logger.info('MCP 工具调用完成 server=%s tool=%s %s', server_name, tool_name, format_observability_for_log())
            return result
        except TimeoutError:
            return error_response(f"MCP 工具调用超时: {server_name}/{tool_name}")
        except Exception as e:
            logger.error(f"MCP 工具调用失败 ({server_name}/{tool_name}): {e}{_obs_suffix()}")
            return error_response(f"MCP 工具调用失败: {e}")

    async def _async_call_tool(self, conn: MCPConnection, tool_name: str, arguments: dict) -> dict:
        """异步调用 MCP 工具并将结果标准化"""
        from tools.response_builder import success_response, error_response

        response = await conn._session.call_tool(tool_name, arguments)

        # 解析 MCP 响应
        # response.content 是 List[TextContent | ImageContent | EmbeddedResource]
        content_list = response.content if hasattr(response, 'content') else []
        is_error = getattr(response, 'isError', False)

        # 提取文本内容
        texts = []
        other_contents = []
        for item in content_list:
            item_type = getattr(item, 'type', None)
            if item_type == 'text':
                texts.append(getattr(item, 'text', ''))
            else:
                other_contents.append({
                    "type": item_type,
                    "data": str(item)
                })

        text_combined = "\n".join(texts) if texts else ""

        if is_error:
            return error_response(text_combined or "MCP 工具返回错误")

        # 构造成功响应
        results = {
            "text": text_combined,
            "content": other_contents
        } if other_contents else text_combined

        return success_response(
            results=results,
            summary=f"MCP 工具 {tool_name} 执行成功"
        )

    # ─── 测试连接 ─────────────────────────────────────────────────────────────

    def test_connection(self, server_name: str) -> dict:
        """
        测试到指定 MCP Server 的连接（先断开再重连）

        Returns:
            {"success": bool, "message": str, "tool_count": int}
        """
        try:
            # 先断开现有连接
            self.disconnect_server(server_name)
            # 重新连接
            success = self.connect_server(server_name)
            if success:
                with self._lock:
                    conn = self._connections.get(server_name)
                tool_count = len(conn.tools) if conn else 0
                return {
                    "success": True,
                    "message": f"连接成功，发现 {tool_count} 个工具",
                    "tool_count": tool_count
                }
            else:
                with self._lock:
                    conn = self._connections.get(server_name)
                err = conn.error_message if conn else "未知错误"
                return {"success": False, "message": err, "tool_count": 0}
        except Exception as e:
            return {
                "success": False,
                "message": self._format_exception_message(e),
                "tool_count": 0,
            }


# ─── 单例 ─────────────────────────────────────────────────────────────────────

def get_mcp_manager() -> MCPClientManager:
    """获取 MCPClientManager 单例（懒初始化，不自动 startup）"""
    return get_runtime_dependency(container_getter='get_mcp_manager')
