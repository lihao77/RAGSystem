# -*- coding: utf-8 -*-
"""
向量库管理 API（插件式）

提供向量化器的列表、新增、激活、按向量化器查文档、迁移、删除。
与 config.embedding 解耦，以 vectorizers.yaml + embedding_models 为数据源。
"""

import json
import logging
import struct
from pathlib import Path

from flask import Blueprint, request, jsonify

from config import get_config
from vector_store.vectorizer_config import get_vectorizer_config_store
from vector_store.embedder import get_embedder_for_vectorizer
from vector_store.model_manager import EmbeddingModelManager

logger = logging.getLogger(__name__)

vector_library_bp = Blueprint("vector_library", __name__)


def _get_db_path():
    """获取向量库 DB 绝对路径"""
    config = get_config()
    p = Path(config.vector_store.sqlite_vec.database_path)
    if not p.is_absolute():
        p = Path(__file__).resolve().parent.parent / p
    return str(p)


def _get_model_manager():
    """获取 model_manager（需已初始化向量存储时可用）；否则仅用 db_path 构造仅用于查询/删除）"""
    try:
        from vector_store.client import get_vector_client
        client = get_vector_client()
        if client._store is not None and hasattr(client._store, "model_manager"):
            return client._store.model_manager
    except Exception:
        pass
    return EmbeddingModelManager(_get_db_path())


@vector_library_bp.route("/file-status", methods=["GET"])
def file_status():
    """
    文件维度索引状态：按文件（文档）列出，每列对应一个向量化器，取值为 已索引 / 未索引。
    用于向量知识库主表：文件名称 | 文档分块数 | 向量化器1 | 向量化器2 | ...
    """
    try:
        mm = _get_model_manager()
        store = get_vectorizer_config_store()
        vectorizer_list = store.list_vectorizers()
        # 只保留在 DB 有 model 的向量化器
        model_by_key = {}
        for r in vectorizer_list:
            key = r["vectorizer_key"]
            model = mm.get_model_by_vectorizer_key(key) if key else None
            if model:
                model_by_key[key] = {
                    "vectorizer_key": key,
                    "model_name": r.get("model_name", ""),
                    "provider_key": r.get("provider_key", ""),
                    "dimension": model.vector_dimension,
                    "model_id": model.id,
                }

        conn = mm.conn
        # 按 (collection, document_id) 聚合；“文件显示名”优先 original_filename，其次 source，最后 document_id
        cursor = conn.execute("""
            SELECT
                collection,
                json_extract(metadata, '$.document_id') AS file_id,
                MAX(COALESCE(
                    NULLIF(TRIM(REPLACE(json_extract(metadata, '$.original_filename'), '"', '')), ''),
                    NULLIF(TRIM(REPLACE(json_extract(metadata, '$.source'), '"', '')), ''),
                    json_extract(metadata, '$.document_id')
                )) AS file_name,
                COUNT(*) AS chunk_count
            FROM documents
            WHERE json_extract(metadata, '$.document_id') IS NOT NULL AND json_extract(metadata, '$.document_id') != ''
            GROUP BY collection, file_id
            ORDER BY collection, file_name
        """)
        rows = cursor.fetchall()
        file_list = []
        for row in rows:
            collection = row[0]
            file_id = (row[1] or "").strip().strip('"')
            raw_name = row[2]
            if isinstance(raw_name, str):
                file_name = raw_name.strip().strip('"')
            else:
                file_name = (raw_name or file_id or "").strip().strip('"') if raw_name else (file_id or "")
            chunk_count = row[3]
            # 该文件下所有 chunk 的 doc id
            cursor2 = conn.execute(
                "SELECT id FROM documents WHERE collection = ? AND json_extract(metadata, '$.document_id') = ?",
                (collection, file_id),
            )
            chunk_ids = [r2[0] for r2 in cursor2.fetchall()]
            vectorizer_status = {}
            for key, info in model_by_key.items():
                mid = info["model_id"]
                if not chunk_ids:
                    vectorizer_status[key] = "未索引"
                else:
                    placeholders = ",".join("?" * len(chunk_ids))
                    cursor3 = conn.execute(
                        "SELECT COUNT(*) FROM document_vectors WHERE model_id = ? AND collection = ? AND doc_id IN (" + placeholders + ")",
                        [mid, collection] + chunk_ids,
                    )
                    cnt = cursor3.fetchone()[0]
                    vectorizer_status[key] = "已索引" if cnt == chunk_count else "未索引"
            file_list.append({
                "file_name": file_name,
                "file_id": file_id,
                "collection": collection,
                "chunk_count": chunk_count,
                "vectorizer_status": vectorizer_status,
            })
        return jsonify({
            "success": True,
            "data": {
                "files": file_list,
                "vectorizers": list(model_by_key.values()),
            },
        })
    except Exception as e:
        logger.exception("获取文件索引状态失败")
        return jsonify({"success": False, "message": str(e)}), 500


@vector_library_bp.route("/index-file", methods=["POST"])
def index_file_with_vectorizer():
    """
    使用指定向量化器对单个文件（按 collection + file_id 确定）建立向量索引。
    body: collection, file_id（即 document_id）, vectorizer_key
    """
    try:
        body = request.get_json() or {}
        collection = (body.get("collection") or "").strip()
        file_id = (body.get("file_id") or "").strip()
        vectorizer_key = (body.get("vectorizer_key") or "").strip()
        if not collection or not file_id or not vectorizer_key:
            return jsonify({"success": False, "message": "缺少 collection、file_id 或 vectorizer_key"}), 400

        store = get_vectorizer_config_store()
        if store.get_vectorizer(vectorizer_key) is None:
            return jsonify({"success": False, "message": f"向量化器不存在: {vectorizer_key}"}), 404

        embedder = get_embedder_for_vectorizer(vectorizer_key)
        if not embedder:
            return jsonify({"success": False, "message": "无法创建该向量化器的 Embedder"}), 400

        mm = _get_model_manager()
        model = mm.get_model_by_vectorizer_key(vectorizer_key)
        if not model:
            return jsonify({"success": False, "message": "该向量化器未在 DB 注册"}), 400

        conn = mm.conn
        # 兼容 json_extract 可能带引号的情况
        cursor = conn.execute(
            "SELECT id, content FROM documents WHERE collection = ? AND TRIM(REPLACE(COALESCE(json_extract(metadata, '$.document_id'), ''), '\"', '')) = ? ORDER BY id",
            (collection, file_id.strip().strip('"')),
        )
        rows = cursor.fetchall()
        if not rows:
            return jsonify({"success": False, "message": "未找到该文件对应的分块"}), 404

        texts = [r[1] for r in rows]
        doc_ids = [r[0] for r in rows]
        embeddings = embedder.embed(texts)
        if isinstance(embeddings[0], float):
            embeddings = [embeddings]

        for i, doc_id in enumerate(doc_ids):
            if i >= len(embeddings):
                break
            vec = embeddings[i]
            blob = struct.pack(f"{len(vec)}f", *vec)
            conn.execute(
                "DELETE FROM document_vectors WHERE doc_id = ? AND collection = ? AND model_id = ?",
                (doc_id, collection, model.id),
            )
            conn.execute(
                "INSERT INTO document_vectors (doc_id, collection, model_id, embedding) VALUES (?, ?, ?, ?)",
                (doc_id, collection, model.id, blob),
            )
        conn.commit()
        return jsonify({
            "success": True,
            "data": {"indexed_count": len(doc_ids), "vectorizer_key": vectorizer_key},
        })
    except Exception as e:
        logger.exception("按向量化器索引文件失败")
        return jsonify({"success": False, "message": str(e)}), 500


@vector_library_bp.route("/vectorizers", methods=["GET"])
def list_vectorizers():
    """列表：所有向量化器（含维度、文档数、是否激活）"""
    try:
        store = get_vectorizer_config_store()
        rows = store.list_vectorizers()
        mm = _get_model_manager()
        active_key = store.get_active_key()
        result = []
        for r in rows:
            key = r["vectorizer_key"]
            model = mm.get_model_by_vectorizer_key(key) if key else None
            stats = mm.get_model_stats(model.id) if model else {}
            result.append({
                "vectorizer_key": key,
                "provider_key": r.get("provider_key", ""),
                "model_name": r.get("model_name", ""),
                "distance_metric": r.get("distance_metric", "cosine"),
                "created_at": r.get("created_at"),
                "is_active": r.get("is_active", False),
                "vector_dimension": model.vector_dimension if model else None,
                "vector_count": stats.get("vector_count", 0),
                "model_id": model.id if model else None,
            })
        return jsonify({"success": True, "data": result})
    except Exception as e:
        logger.exception("列表向量化器失败")
        return jsonify({"success": False, "message": str(e)}), 500


@vector_library_bp.route("/vectorizers", methods=["POST"])
def add_vectorizer():
    """新增向量化器（provider_key, model_name, distance_metric?）；后端解析维度并注册到 DB"""
    try:
        body = request.get_json() or {}
        provider_key = (body.get("provider_key") or "").strip()
        model_name = (body.get("model_name") or "").strip()
        distance_metric = body.get("distance_metric") or "cosine"
        provider_type = body.get("provider_type")

        if not provider_key or not model_name:
            return jsonify({"success": False, "message": "缺少 provider_key 或 model_name"}), 400

        store = get_vectorizer_config_store()
        key = store.add_vectorizer(
            provider_key=provider_key,
            model_name=model_name,
            distance_metric=distance_metric,
            provider_type=provider_type,
        )
        cfg = store.get_vectorizer(key)

        # 解析维度并注册到 embedding_models
        emb = get_embedder_for_vectorizer(key)
        if not emb:
            return jsonify({"success": False, "message": "无法创建该向量化器的 Embedder（请检查 Model Adapter 配置）"}), 400
        dimension = emb.embedding_dim

        mm = _get_model_manager()
        model_id = mm.register_model(
            provider=provider_key,
            model_name=model_name,
            vector_dimension=dimension,
            distance_metric=distance_metric,
            vectorizer_key=key,
            set_active=False,
        )

        return jsonify({
            "success": True,
            "data": {
                "vectorizer_key": key,
                "model_id": model_id,
                "vector_dimension": dimension,
            },
        })
    except ValueError as e:
        return jsonify({"success": False, "message": str(e)}), 400
    except Exception as e:
        logger.exception("新增向量化器失败")
        return jsonify({"success": False, "message": str(e)}), 500


@vector_library_bp.route("/vectorizers/<key>/activate", methods=["POST"])
def activate_vectorizer(key: str):
    """设为当前激活的向量化器"""
    try:
        store = get_vectorizer_config_store()
        if store.get_vectorizer(key) is None:
            return jsonify({"success": False, "message": f"向量化器不存在: {key}"}), 404
        store.set_active_key(key)

        # 同步 DB 激活态
        mm = _get_model_manager()
        model = mm.get_model_by_vectorizer_key(key)
        if model:
            mm.set_active_model(model.id)

        # 重置 Embedder/向量客户端，使下次使用新激活的向量化器
        try:
            from vector_store.embedder import reset_embedder
            from vector_store.client import reset_vector_client
            from init_vector_store import reset_vector_store_initialized
            reset_embedder()
            reset_vector_client()
            reset_vector_store_initialized()
        except Exception as e:
            logger.warning("激活后重置 Embedder/向量客户端时告警: %s", e)

        return jsonify({"success": True, "data": {"active_vectorizer_key": key}})
    except Exception as e:
        logger.exception("激活向量化器失败")
        return jsonify({"success": False, "message": str(e)}), 500


@vector_library_bp.route("/vectorizers/<key>/docs", methods=["GET"])
def list_docs_by_vectorizer(key: str):
    """某向量化器下已向量化的文档（可按 collection 过滤）"""
    try:
        collection = request.args.get("collection")
        mm = _get_model_manager()
        model = mm.get_model_by_vectorizer_key(key)
        if not model:
            return jsonify({"success": False, "message": f"向量化器不存在或未在 DB 注册: {key}"}), 404

        import sqlite3
        conn = sqlite3.connect(_get_db_path())
        conn.row_factory = sqlite3.Row
        try:
            if collection:
                cursor = conn.execute(
                    "SELECT doc_id, collection, created_at FROM document_vectors WHERE model_id = ? AND collection = ? ORDER BY created_at DESC LIMIT 500",
                    (model.id, collection),
                )
            else:
                cursor = conn.execute(
                    "SELECT doc_id, collection, created_at FROM document_vectors WHERE model_id = ? ORDER BY created_at DESC LIMIT 500",
                    (model.id,),
                )
            rows = cursor.fetchall()
            docs = [{"doc_id": r["doc_id"], "collection": r["collection"], "created_at": r["created_at"]} for r in rows]
            return jsonify({"success": True, "data": docs})
        finally:
            conn.close()
    except Exception as e:
        logger.exception("按向量化器查文档失败")
        return jsonify({"success": False, "message": str(e)}), 500


@vector_library_bp.route("/migrate", methods=["POST"])
def migrate():
    """迁移：将某集合的文档用目标向量化器重新向量化并写入"""
    try:
        body = request.get_json() or {}
        source_collection = (body.get("source_collection") or "default").strip()
        target_vectorizer_key = (body.get("target_vectorizer_key") or "").strip()
        if not target_vectorizer_key:
            return jsonify({"success": False, "message": "缺少 target_vectorizer_key"}), 400

        store = get_vectorizer_config_store()
        if store.get_vectorizer(target_vectorizer_key) is None:
            return jsonify({"success": False, "message": f"目标向量化器不存在: {target_vectorizer_key}"}), 404

        from vector_store.client import get_vector_client
        from vector_store.embedder import get_embedder_for_vectorizer
        client = get_vector_client()
        client.ensure_initialized()
        target_embedder = get_embedder_for_vectorizer(target_vectorizer_key)
        if not target_embedder:
            return jsonify({"success": False, "message": "无法创建目标向量化器 Embedder"}), 400

        mm = _get_model_manager()
        target_model = mm.get_model_by_vectorizer_key(target_vectorizer_key)
        if not target_model:
            return jsonify({"success": False, "message": "目标向量化器未在 DB 注册"}), 400

        store_obj = client.store
        conn = store_obj.conn
        cursor = conn.execute(
            "SELECT id, content, metadata FROM documents WHERE collection = ?",
            (source_collection,),
        )
        documents = cursor.fetchall()
        if not documents:
            return jsonify({"success": True, "data": {"migrated_count": 0, "message": "集合无文档"}})

        from vector_store.base import Document
        docs = [Document(id=r["id"], content=r["content"], metadata=json.loads(r["metadata"] or "{}")) for r in documents]
        texts = [d.content for d in docs]
        embeddings = target_embedder.embed(texts)
        if isinstance(embeddings[0], float):
            embeddings = [embeddings]
        migrated = 0
        for i, doc in enumerate(docs):
            if i >= len(embeddings):
                break
            vec = embeddings[i]
            try:
                conn.execute(
                    """INSERT OR REPLACE INTO document_vectors (doc_id, collection, model_id, embedding, created_at)
                       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                    (doc.id, source_collection, target_model.id, store_obj._serialize_vector(vec)),
                )
                migrated += 1
            except Exception as e:
                logger.warning("写入向量失败 %s: %s", doc.id, e)
        conn.commit()
        return jsonify({"success": True, "data": {"migrated_count": migrated, "total": len(docs)}})
    except Exception as e:
        logger.exception("迁移失败")
        return jsonify({"success": False, "message": str(e)}), 500


@vector_library_bp.route("/vectorizers/<key>", methods=["DELETE"])
def delete_vectorizer(key: str):
    """删除该向量化器配置并删除其 document_vectors + embedding_models 记录"""
    try:
        store = get_vectorizer_config_store()
        if store.get_vectorizer(key) is None:
            return jsonify({"success": False, "message": f"向量化器不存在: {key}"}), 404

        mm = _get_model_manager()
        model = mm.get_model_by_vectorizer_key(key)
        if model:
            mm.delete_model(model.id, force=True)
        store.delete_vectorizer(key)

        try:
            from vector_store.embedder import reset_embedder
            from vector_store.client import reset_vector_client
            from init_vector_store import reset_vector_store_initialized
            reset_embedder()
            reset_vector_client()
            reset_vector_store_initialized()
        except Exception as e:
            logger.warning("删除后重置时告警: %s", e)

        return jsonify({"success": True, "data": {"deleted_vectorizer_key": key}})
    except ValueError as e:
        return jsonify({"success": False, "message": str(e)}), 400
    except Exception as e:
        logger.exception("删除向量化器失败")
        return jsonify({"success": False, "message": str(e)}), 500
