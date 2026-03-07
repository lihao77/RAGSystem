# -*- coding: utf-8 -*-
"""
知识图谱系统 Flask 后端入口。
"""

import atexit
import logging
import os
import sys
from typing import List

os.environ['ANONYMIZED_TELEMETRY'] = 'False'
os.environ['CHROMA_TELEMETRY_ENABLED'] = 'False'

from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge

from config import get_config
from config.health_check import run_health_check
from db import close_driver
from routes.agent import agent_bp
from routes.agent_config import agent_config_bp
from routes.config_refactored import config_bp
from routes.embedding_models import embedding_models_bp
from routes.evaluation import evaluation_bp
from routes.files import files_bp
from routes.function_call import function_call_bp
from routes.graphrag_refactored import graphrag_bp
from routes.home import home_bp
from routes.mcp import mcp_bp
from routes.model_adapter import model_adapter_bp
from routes.nodes import nodes_bp
from routes.search_refactored import search_bp
from routes.vector_library import vector_library_bp
from routes.vector_management import vector_management_bp
from routes.visualization_refactored import visualization_bp
from routes.workflows import workflow_bp

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BACKEND_DIR, '..'))
DEFAULT_UPLOAD_FOLDER = os.path.join(BACKEND_DIR, 'uploads')
DEFAULT_FRONTEND_DIST = os.path.join(PROJECT_ROOT, 'frontend', 'dist')
DEFAULT_CORS_ORIGINS = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:8081',
    'http://127.0.0.1:8081',
]

_runtime_initialized = False
_shutdown_hooks_registered = False


def _parse_csv_env(name: str, default: List[str]) -> List[str]:
    raw_value = os.environ.get(name, '').strip()
    if not raw_value:
        return list(default)
    return [item.strip() for item in raw_value.split(',') if item.strip()]


def _resolve_backend_path(path_value: str, fallback: str) -> str:
    if not path_value:
        return fallback
    if os.path.isabs(path_value):
        return path_value
    return os.path.abspath(os.path.join(BACKEND_DIR, path_value))


def _get_cors_origins() -> List[str]:
    return _parse_csv_env('CORS_ORIGINS', DEFAULT_CORS_ORIGINS)


def _parse_bool_env(name: str, default: bool) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() == 'true'


def _get_default_use_reloader(debug_mode: bool) -> bool:
    if not debug_mode:
        return False
    return os.name != 'nt'


def _patch_windows_werkzeug_shutdown_race() -> None:
    if os.name != 'nt':
        return

    try:
        from werkzeug.serving import BaseWSGIServer
    except Exception:
        return

    if getattr(BaseWSGIServer, '_ragsystem_win10038_patched', False):
        return

    original_serve_forever = BaseWSGIServer.serve_forever

    def _serve_forever(self, poll_interval: float = 0.5):
        try:
            return original_serve_forever(self, poll_interval=poll_interval)
        except OSError as error:
            if getattr(error, 'winerror', None) == 10038:
                logger.debug('忽略 Windows 下 Werkzeug 退出时的 WinError 10038')
                return None
            raise

    BaseWSGIServer.serve_forever = _serve_forever
    BaseWSGIServer._ragsystem_win10038_patched = True


def register_blueprints(app: Flask) -> None:
    app.register_blueprint(home_bp, url_prefix='/api/home')
    app.register_blueprint(search_bp, url_prefix='/api/search')
    app.register_blueprint(visualization_bp, url_prefix='/api/visualization')
    app.register_blueprint(evaluation_bp, url_prefix='/api/evaluation')
    app.register_blueprint(graphrag_bp, url_prefix='/api/graphrag')
    app.register_blueprint(function_call_bp, url_prefix='/api/function-call')
    app.register_blueprint(config_bp, url_prefix='/api/config')
    app.register_blueprint(nodes_bp)
    app.register_blueprint(workflow_bp)
    app.register_blueprint(files_bp)
    app.register_blueprint(vector_management_bp)
    app.register_blueprint(model_adapter_bp, url_prefix='/api/model-adapter')
    app.register_blueprint(agent_bp, url_prefix='/api/agent')
    app.register_blueprint(agent_config_bp, url_prefix='/api/agent-config')
    app.register_blueprint(embedding_models_bp, url_prefix='/api/embedding-models')
    app.register_blueprint(vector_library_bp, url_prefix='/api/vector-library')
    app.register_blueprint(mcp_bp, url_prefix='/api/mcp')


def register_static_routes(app: Flask) -> None:
    @app.route('/')
    def frontend_index():
        frontend_dist = app.config['FRONTEND_DIST']
        index_path = os.path.join(frontend_dist, 'index.html')
        if os.path.exists(index_path):
            return send_from_directory(frontend_dist, 'index.html')
        return jsonify({'message': '前端文件未找到'}), 404

    @app.route('/uploads/<filename>')
    def uploaded_file(filename: str):
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    @app.route('/<path:filename>')
    def frontend_static(filename: str):
        frontend_dist = app.config['FRONTEND_DIST']
        if os.path.exists(os.path.join(frontend_dist, filename)):
            return send_from_directory(frontend_dist, filename)
        index_path = os.path.join(frontend_dist, 'index.html')
        if os.path.exists(index_path):
            return send_from_directory(frontend_dist, 'index.html')
        return jsonify({'message': '文件未找到'}), 404


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(404)
    def not_found(error):
        return jsonify({'message': '接口不存在'}), 404

    @app.errorhandler(500)
    def internal_error(error):
        logger.error('服务器内部错误: %s', error)
        return jsonify({'message': '服务器内部错误'}), 500

    @app.errorhandler(RequestEntityTooLarge)
    def handle_file_too_large(error):
        return jsonify({'message': '文件过大，请上传小于100MB的文件'}), 413


def create_app() -> Flask:
    app = Flask(__name__)
    config = get_config()
    upload_folder = _resolve_backend_path(os.environ.get('UPLOAD_FOLDER', ''), DEFAULT_UPLOAD_FOLDER)
    frontend_dist = _resolve_backend_path(os.environ.get('FRONTEND_DIST', ''), DEFAULT_FRONTEND_DIST)
    cors_origins = _get_cors_origins()

    logger.info('配置加载完成: Neo4j URI = %s', config.neo4j.uri)
    logger.info('CORS 白名单: %s', ', '.join(cors_origins))

    app.config['MAX_CONTENT_LENGTH'] = config.system.max_content_length
    app.config['UPLOAD_FOLDER'] = upload_folder
    app.config['FRONTEND_DIST'] = frontend_dist

    os.makedirs(upload_folder, exist_ok=True)

    CORS(
        app,
        origins=cors_origins,
        methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allow_headers=['Content-Type', 'Authorization'],
        supports_credentials=True,
    )

    register_blueprints(app)
    register_static_routes(app)
    register_error_handlers(app)
    return app


def test_db_connection() -> bool:
    """测试数据库连接（仅在已配置时执行）"""
    from db import is_neo4j_configured, neo4j_conn

    if not is_neo4j_configured():
        logger.info('⚠ Neo4j 未配置，将在配置完成后初始化')
        return False

    try:
        driver = neo4j_conn.connect()
        if driver:
            with driver.session() as session:
                session.run('RETURN 1')
            logger.info('✓ Neo4j 数据库连接成功')
            return True
        logger.warning('✗ Neo4j 连接失败')
        return False
    except Exception as error:
        logger.error('✗ Neo4j 数据库连接失败: %s', error)
        return False


def init_vector_database() -> bool:
    """初始化向量数据库（仅在已配置时执行）"""
    from init_vector_store import init_vector_store, is_vector_db_configured

    if not is_vector_db_configured():
        logger.info('⚠ 向量数据库未配置，将在配置完成后初始化')
        return False

    try:
        success = init_vector_store()
        if not success:
            logger.warning('⚠ 向量数据库初始化失败，但不影响其他功能')
        return success
    except Exception as error:
        logger.warning('⚠ 向量数据库初始化失败: %s', error)
        return False


def initialize_runtime_services(app: Flask) -> None:
    global _runtime_initialized

    if _runtime_initialized:
        return

    with app.app_context():
        logger.info('=' * 70)
        logger.info('开始检查和初始化数据库连接...')
        logger.info('=' * 70)

        neo4j_ok = test_db_connection()
        vector_ok = init_vector_database()

        logger.info('=' * 70)
        logger.info('数据库初始化完成')
        logger.info('  %s Neo4j: %s', '✓' if neo4j_ok else '✗', '已连接' if neo4j_ok else '未配置或连接失败')
        logger.info('  %s 向量数据库: %s', '✓' if vector_ok else '✗', '已初始化' if vector_ok else '未配置或初始化失败')
        logger.info('=' * 70)

        try:
            from mcp import get_mcp_manager

            get_mcp_manager().startup()
            logger.info('  ✓ MCP Client Manager: 已启动')
        except Exception as error:
            logger.warning('  ⚠ MCP Client Manager 启动失败（不影响其他功能）: %s', error)

    _runtime_initialized = True


def register_shutdown_hooks() -> None:
    global _shutdown_hooks_registered

    if _shutdown_hooks_registered:
        return

    atexit.register(close_driver)

    def _shutdown_mcp() -> None:
        try:
            from mcp import get_mcp_manager

            get_mcp_manager().shutdown()
        except Exception:
            pass

    atexit.register(_shutdown_mcp)
    _shutdown_hooks_registered = True


def run_startup_checks_or_exit(app: Flask, initialize_runtime: bool = True) -> None:
    if not run_health_check():
        print('\n请修复上述配置错误后重新启动。')
        sys.exit(1)

    if initialize_runtime:
        initialize_runtime_services(app)


app = create_app()
register_shutdown_hooks()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', os.environ.get('FLASK_PORT', 5000)))
    host = os.environ.get('FLASK_HOST', '0.0.0.0')
    debug_mode = _parse_bool_env('FLASK_DEBUG', True)
    use_reloader = _parse_bool_env('FLASK_USE_RELOADER', _get_default_use_reloader(debug_mode))
    should_init_runtime = not (debug_mode and use_reloader and os.environ.get('WERKZEUG_RUN_MAIN') != 'true')

    _patch_windows_werkzeug_shutdown_race()

    run_startup_checks_or_exit(app, initialize_runtime=should_init_runtime)

    if debug_mode and not use_reloader:
        logger.info('提示: 开发模式已启动，但自动重载已禁用（避免双重初始化）')
        logger.info('      如需自动重载，设置环境变量: FLASK_USE_RELOADER=True')
    elif debug_mode and os.name == 'nt':
        logger.info('提示: 已为 Windows 开发环境启用 Werkzeug 退出兼容处理')

    app.run(
        host=host,
        port=port,
        debug=debug_mode,
        use_reloader=use_reloader,
    )
