# -*- coding: utf-8 -*-
"""
Neo4j数据库连接模块
"""

from neo4j import GraphDatabase
from config import get_config
import logging

logger = logging.getLogger(__name__)

# Neo4j连接配置
class Neo4jConnection:
    def __init__(self):
        self.driver = None
        self.config = None
        self.connect()

    def connect(self):
        """建立Neo4j连接"""
        try:
            # 从配置系统获取Neo4j配置
            self.config = get_config()
            uri = self.config.neo4j.uri
            user = self.config.neo4j.user
            password = self.config.neo4j.password
            print(uri, user, password)
            self.driver = GraphDatabase.driver(
                uri,
                auth=(user, password)
            )
            logger.info('Neo4j连接已建立')
        except Exception as e:
            logger.error(f'Neo4j连接失败: {e}')
            raise
    
    def close(self):
        """关闭Neo4j连接"""
        if self.driver:
            self.driver.close()
            logger.info('Neo4j连接已关闭')
    
    def get_session(self):
        """获取Neo4j会话"""
        if not self.driver:
            self.connect()
        return self.driver.session()

# 全局连接实例
neo4j_conn = Neo4jConnection()

# 获取驱动实例
def get_driver():
    """获取Neo4j驱动实例"""
    return neo4j_conn.driver

# 获取会话
def get_session():
    """获取Neo4j会话"""
    return neo4j_conn.get_session()

# 测试数据库连接
def test_connection():
    """测试数据库连接"""
    session = None
    try:
        session = get_session()
        result = session.run('RETURN 1 as n')
        record = result.single()
        if record:
            logger.info(f'Neo4j连接成功: {record["n"]}')
            return True
        else:
            logger.error('Neo4j连接测试失败: 无返回结果')
            return False
    except Exception as e:
        logger.error(f'Neo4j连接测试失败: {e}')
        return False
    finally:
        if session:
            session.close()

# 优雅关闭
def close_driver():
    """关闭数据库连接"""
    neo4j_conn.close()

# 导出常用对象
driver = neo4j_conn.driver