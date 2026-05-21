# -*- coding: utf-8 -*-
"""端口检测工具：启动时自动检测端口冲突并寻找可用端口。"""

import logging
import socket

logger = logging.getLogger(__name__)

MAX_PORT_SEARCH = 20


def is_port_in_use(port: int, host: str = '127.0.0.1') -> bool:
    """检测端口是否已被占用。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex((host, port)) == 0


def find_free_port(preferred: int, host: str = '127.0.0.1') -> int:
    """从 preferred 开始寻找第一个可用端口，最多尝试 MAX_PORT_SEARCH 次。"""
    for offset in range(MAX_PORT_SEARCH):
        candidate = preferred + offset
        if not is_port_in_use(candidate, host):
            if offset > 0:
                logger.warning(
                    '端口 %d 已被占用，自动切换到 %d', preferred, candidate,
                )
            return candidate
    raise RuntimeError(
        f'端口 {preferred}-{preferred + MAX_PORT_SEARCH - 1} 均被占用，'
        f'请手动指定: PORT=<port> python main.py'
    )
