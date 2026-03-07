# -*- coding: utf-8 -*-
"""
Neo4j 数据库连接模块。
"""

import logging

from neo4j import GraphDatabase

from config import get_config

logger = logging.getLogger(__name__)


class Neo4jConnection:
    """Neo4j 连接管理器（延迟初始化）。"""

    def __init__(self):
        self.driver = None
        self.config = None

    def connect(self):
        """建立 Neo4j 连接。"""
        if self.driver is not None:
            logger.debug('Neo4j连接已存在，跳过重复连接')
            return self.driver

        try:
            self.config = get_config()
            uri = self.config.neo4j.uri
            user = self.config.neo4j.user
            password = self.config.neo4j.password

            if not uri or not user or not password:
                logger.warning('Neo4j未配置，无法建立连接')
                return None

            logger.info('正在连接 Neo4j: %s', uri)
            self.driver = GraphDatabase.driver(uri, auth=(user, password))
            logger.info('✓ Neo4j连接已建立')
            return self.driver
        except Exception as error:
            logger.error('✗ Neo4j连接失败: %s', error)
            raise

    def close(self):
        """关闭 Neo4j 连接。"""
        if self.driver:
            self.driver.close()
            self.driver = None
            logger.info('Neo4j连接已关闭')

    def reconnect(self):
        """重新连接（用于配置更新后）。"""
        logger.info('重新连接 Neo4j...')
        self.close()
        return self.connect()

    def get_session(self):
        """获取 Neo4j 会话。"""
        if not self.driver:
            self.connect()
        if not self.driver:
            raise RuntimeError('Neo4j未配置或连接失败')
        return self.driver.session()


neo4j_conn = Neo4jConnection()



def get_neo4j_connection() -> Neo4jConnection:
    try:
        from runtime.container import get_current_runtime_container

        container = get_current_runtime_container()
        if container is not None:
            return container.get_neo4j_connection()
    except Exception:
        pass

    return neo4j_conn



def get_driver():
    """获取驱动实例（自动连接）。"""
    connection = get_neo4j_connection()
    if not connection.driver:
        connection.connect()
    return connection.driver



def get_session():
    """获取 Neo4j 会话（自动连接）。"""
    return get_neo4j_connection().get_session()



def is_neo4j_configured():
    """检查 Neo4j 是否已配置。"""
    try:
        config = get_config()
        return bool(config.neo4j.uri and config.neo4j.user and config.neo4j.password)
    except Exception:
        return False



def test_connection():
    """测试数据库连接。"""
    if not is_neo4j_configured():
        logger.warning('Neo4j未配置')
        return False

    session = None
    try:
        session = get_session()
        result = session.run('RETURN 1 as n')
        record = result.single()
        if record:
            logger.info('Neo4j连接成功: %s', record['n'])
            return True
        logger.error('Neo4j连接测试失败: 无返回结果')
        return False
    except Exception as error:
        logger.error('Neo4j连接测试失败: %s', error)
        return False
    finally:
        if session:
            session.close()



def close_driver():
    """关闭数据库连接。"""
    get_neo4j_connection().close()
