# -*- coding: utf-8 -*-
"""
向量库管理API
"""

from flask import Blueprint, request, jsonify
import logging
from vector_store import (
    get_vector_client,
    DocumentIndexer,
    VectorRetriever
)

logger = logging.getLogger(__name__)

vector_management_bp = Blueprint('vector_management', __name__, url_prefix='/api/vector')


@vector_management_bp.route('/collections', methods=['GET'])
def list_collections():
    """列出所有向量集合"""
    try:
        client = get_vector_client()
        collections = client.list_collections()  # 返回字符串列表

        # 获取每个集合的统计信息
        collection_stats = []
        for collection_name in collections:
            try:
                # 获取集合详细信息
                info = client.get_collection_info(collection_name)
                collection_stats.append({
                    "name": info.get('name', collection_name),
                    "total_chunks": info.get('document_count', 0),
                    "embedding_dimension": info.get('vector_dimension', 0),
                    "model_name": '',  # SQLite 不存储模型名称
                    "metadata": info.get('metadata', {})
                })
            except Exception as e:
                logger.error(f"获取集合统计失败 {collection_name}: {e}")
                collection_stats.append({
                    "name": collection_name,
                    "total_chunks": 0,
                    "embedding_dimension": 0,
                    "model_name": '',
                    "metadata": {},
                    "error": str(e)
                })

        return jsonify({
            "success": True,
            "data": collection_stats,
            "count": len(collection_stats)
        })

    except Exception as e:
        logger.error(f"列出集合失败: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@vector_management_bp.route('/collections/<collection_name>', methods=['DELETE'])
def delete_collection(collection_name):
    """删除向量集合"""
    try:
        client = get_vector_client()
        client.delete_collection(collection_name)
        
        return jsonify({
            "success": True,
            "message": f"集合 {collection_name} 已删除"
        })
        
    except Exception as e:
        logger.error(f"删除集合失败: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@vector_management_bp.route('/search', methods=['POST'])
def search_vectors():
    """向量检索测试接口"""
    try:
        data = request.json
        collection_name = data.get('collection_name', 'documents')
        query = data.get('query', '')
        top_k = data.get('top_k', 5)
        
        if not query:
            return jsonify({
                "success": False,
                "error": "查询内容不能为空"
            }), 400
        
        retriever = VectorRetriever(collection_name=collection_name)
        results = retriever.search(
            query=query,
            top_k=top_k,
            include_distances=True
        )
        
        return jsonify({
            "success": True,
            "data": {
                "results": results,
                "count": len(results),
                "collection_name": collection_name,
                "query": query
            }
        })
        
    except Exception as e:
        logger.error(f"向量检索失败: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@vector_management_bp.route('/index', methods=['POST'])
def index_document():
    """索引文档（支持直接文本、文件上传、文件ID三种方式）"""
    try:
        import os
        
        # 方式1: 文件上传
        if 'file' in request.files:
            file = request.files['file']
            if file.filename == '':
                return jsonify({
                    "success": False,
                    "error": "未选择文件"
                }), 400
            
            # 读取文件内容
            try:
                text = file.read().decode('utf-8')
            except UnicodeDecodeError:
                return jsonify({
                    "success": False,
                    "error": "文件编码错误，请确保文件为UTF-8编码"
                }), 400
            
            # 从表单获取其他参数
            collection_name = request.form.get('collection_name', 'documents')
            document_id = request.form.get('document_id', file.filename)
            metadata = {
                'source': request.form.get('source', file.filename),
                'document_type': request.form.get('document_type', 'general'),
                'original_filename': file.filename
            }
            chunk_size = int(request.form.get('chunk_size', 500))
            overlap = int(request.form.get('overlap', 50))
        
        else:
            # 方式2/3: JSON数据
            data = request.json
            collection_name = data.get('collection_name', 'documents')
            document_id = data.get('document_id', '')
            metadata = data.get('metadata', {})
            chunk_size = data.get('chunk_size', 500)
            overlap = data.get('overlap', 50)
            
            # 方式2: 从文件管理系统读取
            file_id = data.get('file_id')
            if file_id:
                # 从文件索引中查询文件记录
                from file_index import FileIndex
                file_index = FileIndex()
                file_record = file_index.get(file_id)
                
                if not file_record:
                    return jsonify({
                        "success": False,
                        "error": f"文件不存在: {file_id}"
                    }), 404
                
                # 使用 stored_path 读取文件
                file_path = file_record.get('stored_path')
                if not file_path or not os.path.exists(file_path):
                    return jsonify({
                        "success": False,
                        "error": f"文件路径无效: {file_path}"
                    }), 404
                
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        text = f.read()
                except Exception as e:
                    return jsonify({
                        "success": False,
                        "error": f"读取文件失败: {str(e)}"
                    }), 500
                
                # 自动设置元数据（使用原始文件名）
                original_name = file_record.get('original_name', file_id)
                if not document_id:
                    document_id = original_name
                metadata['source'] = metadata.get('source', original_name)
                metadata['file_id'] = file_id
                metadata['original_filename'] = original_name
            
            # 方式3: 直接提供文本
            else:
                text = data.get('text', '')
                
                if not text:
                    return jsonify({
                        "success": False,
                        "error": "必须提供 text、file_id 或上传文件"
                    }), 400
        
        # 验证必需参数
        if not document_id or not text:
            return jsonify({
                "success": False,
                "error": "document_id和文本内容不能为空"
            }), 400
        
        # 执行索引
        indexer = DocumentIndexer(collection_name=collection_name)
        
        chunk_count = indexer.index_document(
            document_id=document_id,
            text=text,
            metadata=metadata,
            chunk_size=chunk_size,
            overlap=overlap
        )
        
        stats = indexer.get_collection_stats()
        
        return jsonify({
            "success": True,
            "data": {
                "document_id": document_id,
                "chunk_count": chunk_count,
                "collection_name": collection_name,
                "stats": stats
            },
            "message": f"成功索引文档，生成 {chunk_count} 个分块"
        })
        
    except Exception as e:
        logger.error(f"索引文档失败: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@vector_management_bp.route('/documents/<collection_name>/<document_id>', methods=['DELETE'])
def delete_document(collection_name, document_id):
    """删除文档"""
    try:
        indexer = DocumentIndexer(collection_name=collection_name)
        indexer.delete_document(document_id)
        
        return jsonify({
            "success": True,
            "message": f"文档 {document_id} 已从集合 {collection_name} 中删除"
        })
        
    except Exception as e:
        logger.error(f"删除文档失败: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@vector_management_bp.route('/documents/<collection_name>', methods=['GET'])
def list_documents(collection_name):
    """列出集合中的文档"""
    try:
        retriever = VectorRetriever(collection_name=collection_name)
        
        # 获取集合信息（包含示例）
        info = retriever.get_collection_info()
        
        # 这里简化实现，返回集合基本信息
        # 完整实现需要遍历所有文档ID（需要额外的查询逻辑）
        
        return jsonify({
            "success": True,
            "data": {
                "collection_name": collection_name,
                "total_chunks": info.get('total_chunks', 0),
                "sample_ids": info.get('sample_ids', []),
                "info": info
            }
        })
        
    except Exception as e:
        logger.error(f"列出文档失败: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@vector_management_bp.route('/health', methods=['GET'])
def health_check():
    """健康检查"""
    try:
        client = get_vector_client()
        collections = client.list_collections()
        
        return jsonify({
            "success": True,
            "data": {
                "status": "healthy",
                "collections_count": len(collections)
            }
        })
        
    except Exception as e:
        logger.error(f"健康检查失败: {e}")
        return jsonify({
            "success": False,
            "error": str(e),
            "data": {
                "status": "unhealthy"
            }
        }), 500
