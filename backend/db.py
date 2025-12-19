# -*- coding: utf-8 -*-
"""
Neo4j数据库连接模块 - 支持延迟初始化和单例模式
"""

from neo4j import GraphDatabase
from config import get_config
import logging

logger = logging.getLogger(__name__)

# Neo4j连接配置
class Neo4jConnection:
    """Neo4j连接管理器（单例模式，延迟初始化）"""
    
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self.driver = None
        self.config = None
        self._initialized = True

    def connect(self):
        """建立Neo4j连接"""
        # 如果已经连接，直接返回
        if self.driver is not None:
            logger.debug('Neo4j连接已存在，跳过重复连接')
            return self.driver
        
        try:
            # 从配置系统获取Neo4j配置
            self.config = get_config()
            uri = self.config.neo4j.uri
            user = self.config.neo4j.user
            password = self.config.neo4j.password
            
            # 检查是否已配置
            if not uri or not user or not password:
                logger.warning('Neo4j未配置，无法建立连接')
                return None
            
            logger.info(f'正在连接 Neo4j: {uri}')
            self.driver = GraphDatabase.driver(
                uri,
                auth=(user, password)
            )
            logger.info('✓ Neo4j连接已建立')
            return self.driver
        except Exception as e:
            logger.error(f'✗ Neo4j连接失败: {e}')
            raise
    
    def close(self):
        """关闭Neo4j连接"""
        if self.driver:
            self.driver.close()
            self.driver = None
            logger.info('Neo4j连接已关闭')
    
    def reconnect(self):
        """重新连接（用于配置更新后）"""
        logger.info('重新连接 Neo4j...')
        self.close()
        return self.connect()
    
    def get_session(self):
        """获取Neo4j会话"""
        if not self.driver:
            self.connect()
        if not self.driver:
            raise RuntimeError('Neo4j未配置或连接失败')
        return self.driver.session()

# 全局连接实例（单例，延迟初始化）
neo4j_conn = Neo4jConnection()

# 获取驱动实例
def get_driver():
    """获取Neo4j驱动实例（自动连接）"""
    if not neo4j_conn.driver:
        neo4j_conn.connect()
    return neo4j_conn.driver

# 获取会话
def get_session():
    """获取Neo4j会话（自动连接）"""
    return neo4j_conn.get_session()

# 检查Neo4j是否已配置
def is_neo4j_configured():
    """检查Neo4j是否已配置"""
    try:
        config = get_config()
        return bool(config.neo4j.uri and config.neo4j.user and config.neo4j.password)
    except Exception:
        return False

# 测试数据库连接
def test_connection():
    """测试数据库连接"""
    if not is_neo4j_configured():
        logger.warning('Neo4j未配置')
        return False
    
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