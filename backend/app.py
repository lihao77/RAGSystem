# -*- coding: utf-8 -*-
"""
知识图谱系统Flask后端
"""

# 必须在导入 chromadb 之前设置环境变量
import os
os.environ['ANONYMIZED_TELEMETRY'] = 'False'  # 禁用 ChromaDB 遥测
os.environ['CHROMA_TELEMETRY_ENABLED'] = 'False'  # 额外保险

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

import logging
from werkzeug.exceptions import RequestEntityTooLarge

# 导入配置系统
from config import get_config

# 导入蓝图
from routes.home import home_bp
from routes.search_refactored import search_bp  # 使用重构版本
# 使用重构后的visualization路由（原版本备份在visualization.py.backup）
from routes.visualization_refactored import visualization_bp
from routes.evaluation import evaluation_bp
# 使用重构后的graphrag路由（原版本备份在graphrag.py.backup）
from routes.graphrag_refactored import graphrag_bp
from routes.function_call import function_call_bp
from routes.config_refactored import config_bp
from routes.nodes import nodes_bp
from routes.workflows import workflow_bp
from routes.files import files_bp
from routes.vector_management import vector_management_bp
from routes.model_adapter import model_adapter_bp
from routes.agent import agent_bp
from routes.agent_config import agent_config_bp
from routes.embedding_models import embedding_models_bp
from routes.vector_library import vector_library_bp

# 导入数据库连接
from db import test_connection, close_driver

# 创建Flask应用
app = Flask(__name__)

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 加载配置
config = get_config()
logger.info(f"配置加载完成: Neo4j URI = {config.neo4j.uri}")

# 应用配置
app.config['MAX_CONTENT_LENGTH'] = config.system.max_content_length
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')

# 启用CORS
CORS(app,
     origins=[
         'http://localhost:5173', 'http://127.0.0.1:5173',
         'http://localhost:8081', 'http://127.0.0.1:8081',
         'http://localhost:8080', 'http://127.0.0.1:8080',
         'http://10.24.250.158:8080', 'http://10.24.250.158:8081', 'http://10.24.250.158:5173'
     ],
     methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
     allow_headers=['Content-Type', 'Authorization'],
     supports_credentials=True)

# 确保上传目录存在
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# 注册蓝图
app.register_blueprint(home_bp, url_prefix='/api/home')
app.register_blueprint(search_bp, url_prefix='/api/search')
app.register_blueprint(visualization_bp, url_prefix='/api/visualization')
app.register_blueprint(evaluation_bp, url_prefix='/api/evaluation')
app.register_blueprint(graphrag_bp, url_prefix='/api/graphrag')
app.register_blueprint(function_call_bp, url_prefix='/api/function-call')
app.register_blueprint(config_bp, url_prefix='/api/config')
app.register_blueprint(nodes_bp)  # 已包含 url_prefix='/api/nodes'
app.register_blueprint(workflow_bp)  # /api/workflows
app.register_blueprint(files_bp)  # /api/files
app.register_blueprint(vector_management_bp)  # /api/vector
app.register_blueprint(model_adapter_bp, url_prefix='/api/model-adapter')
app.register_blueprint(agent_bp, url_prefix='/api/agent')
app.register_blueprint(agent_config_bp, url_prefix='/api/agent-config')
app.register_blueprint(embedding_models_bp, url_prefix='/api/embedding-models')
app.register_blueprint(vector_library_bp, url_prefix='/api/vector-library')

# 静态文件服务
@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# 前端静态文件服务
# @app.route('/')
# def index():
#     frontend_dist = os.path.join(os.path.dirname(__file__), '../frontend/dist')
#     if os.path.exists(os.path.join(frontend_dist, 'index.html')):
#         return send_from_directory(frontend_dist, 'index.html')
#     return jsonify({'message': '前端文件未找到'}), 404

@app.route('/<path:filename>')
def frontend_static(filename):
    frontend_dist = os.path.join(os.path.dirname(__file__), '../frontend/dist')
    if os.path.exists(os.path.join(frontend_dist, filename)):
        return send_from_directory(frontend_dist, filename)
    # 如果文件不存在，返回index.html（用于SPA路由）
    if os.path.exists(os.path.join(frontend_dist, 'index.html')):
        return send_from_directory(frontend_dist, 'index.html')
    return jsonify({'message': '文件未找到'}), 404

# 错误处理
@app.errorhandler(404)
def not_found(error):
    return jsonify({'message': '接口不存在'}), 404

@app.errorhandler(500)
def internal_error(error):
    logger.error(f'服务器内部错误: {error}')
    return jsonify({'message': '服务器内部错误'}), 500

@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(error):
    return jsonify({'message': '文件过大，请上传小于100MB的文件'}), 413

def test_db_connection():
    """测试数据库连接（仅在已配置时执行）"""
    from db import is_neo4j_configured, neo4j_conn
    
    # 先检查是否已配置
    if not is_neo4j_configured():
        logger.info('⚠ Neo4j 未配置，将在配置完成后初始化')
        return False
    
    try:
        # 尝试连接（单例模式，不会重复连接）
        driver = neo4j_conn.connect()
        if driver:
            # 测试连接
            with driver.session() as session:
                session.run('RETURN 1')
            logger.info('✓ Neo4j 数据库连接成功')
            return True
        else:
            logger.warning('✗ Neo4j 连接失败')
            return False
    except Exception as e:
        logger.error(f'✗ Neo4j 数据库连接失败: {e}')
        return False

def init_vector_database():
    """初始化向量数据库（仅在已配置时执行）"""
    from init_vector_store import is_vector_db_configured, init_vector_store
    
    # 先检查是否已配置
    if not is_vector_db_configured():
        logger.info('⚠ 向量数据库未配置，将在配置完成后初始化')
        return False
    
    try:
        # 初始化（内置重复检查，不会重复初始化）
        success = init_vector_store()
        if not success:
            logger.warning('⚠ 向量数据库初始化失败，但不影响其他功能')
        return success
    except Exception as e:
        logger.warning(f'⚠ 向量数据库初始化失败: {e}')
        return False

# 在应用启动时初始化数据库
with app.app_context():
    logger.info("=" * 70)
    logger.info("开始检查和初始化数据库连接...")
    logger.info("=" * 70)
    
    # 1. 测试 Neo4j 连接
    neo4j_ok = test_db_connection()
    
    # 2. 初始化向量数据库
    vector_ok = init_vector_database()
    
    logger.info("=" * 70)
    logger.info("数据库初始化完成")
    if neo4j_ok:
        logger.info("  ✓ Neo4j: 已连接")
    else:
        logger.info("  ✗ Neo4j: 未配置或连接失败")
    
    if vector_ok:
        logger.info("  ✓ 向量数据库: 已初始化")
    else:
        logger.info("  ✗ 向量数据库: 未配置或初始化失败")
    logger.info("=" * 70)

# 优雅关闭
import atexit
atexit.register(close_driver)

if __name__ == '__main__':
    # 启动Flask应用
    port = int(os.environ.get('PORT', 5000))
    debug_mode = os.environ.get('FLASK_DEBUG', 'True').lower() == 'true'
    use_reloader = os.environ.get('FLASK_USE_RELOADER', 'True').lower() == 'true'
    
    if debug_mode and not use_reloader:
        logger.info("提示: 开发模式已启动，但自动重载已禁用（避免双重初始化）")
        logger.info("      如需自动重载，设置环境变量: FLASK_USE_RELOADER=True")
    
    app.run(
        host='0.0.0.0', 
        port=port, 
        debug=debug_mode,
        use_reloader=use_reloader
    )