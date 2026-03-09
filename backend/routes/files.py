# -*- coding: utf-8 -*-
"""文件管理 API（本地 uploads + 文件索引，默认 SQLite）"""

import os
from pathlib import Path
from flask import Blueprint, request, jsonify, current_app, send_from_directory
from werkzeug.utils import secure_filename

from file_index import FileIndex

files_bp = Blueprint('files', __name__, url_prefix='/api/files')

_index = None


def get_index() -> FileIndex:
    global _index
    if _index is None:
        _index = FileIndex()
    return _index


@files_bp.route('', methods=['GET'])
def list_files():
    """
    List files with optional filtering
    
    Query Parameters:
        extensions: Comma-separated list of extensions (e.g., ".pdf,.docx")
        mime_types: Comma-separated list of MIME types (e.g., "application/pdf")
    
    Note: When both extension and MIME type filters are provided, files matching 
    either filter are returned (OR logic) per Requirement 4.5.
    """
    extensions = request.args.get('extensions', '').split(',') if request.args.get('extensions') else None
    mime_types = request.args.get('mime_types', '').split(',') if request.args.get('mime_types') else None
    
    items = get_index().list()
    
    # Apply filters with OR logic when both are provided (Requirement 4.5)
    if extensions and mime_types:
        # Normalize filters (case-insensitive)
        extensions = [ext.lower().strip() for ext in extensions if ext.strip()]
        mime_types = [mt.lower().strip() for mt in mime_types if mt.strip()]
        
        # OR logic: include files matching either extension OR MIME type
        items = [
            f for f in items 
            if any(f.get('original_name', '').lower().endswith(ext) for ext in extensions)
            or f.get('mime', '').lower() in mime_types
        ]
    # Apply only extension filters (case-insensitive)
    elif extensions:
        extensions = [ext.lower().strip() for ext in extensions if ext.strip()]
        items = [f for f in items if any(f.get('original_name', '').lower().endswith(ext) for ext in extensions)]
    # Apply only MIME type filters (case-insensitive)
    elif mime_types:
        mime_types = [mt.lower().strip() for mt in mime_types if mt.strip()]
        items = [f for f in items if f.get('mime', '').lower() in mime_types]
    
    return jsonify({"success": True, "files": items})


@files_bp.route('/<file_id>', methods=['GET'])
def get_file(file_id: str):
    rec = get_index().get(file_id)
    if not rec:
        return jsonify({"success": False, "error": "文件不存在"}), 404
    return jsonify({"success": True, "file": rec})


@files_bp.route('/upload', methods=['POST'])
def upload_files():
    if 'files' not in request.files:
        return jsonify({"success": False, "error": "缺少 files 字段"}), 400

    files = request.files.getlist('files')
    if not files:
        return jsonify({"success": False, "error": "未选择文件"}), 400

    upload_dir = Path(current_app.config['UPLOAD_FOLDER'])
    upload_dir.mkdir(parents=True, exist_ok=True)

    created = []
    for f in files:
        if not f or not f.filename:
            continue
        filename = secure_filename(f.filename)
        # 避免重名覆盖
        stored_name = f"{os.urandom(8).hex()}_{filename}"
        stored_path = upload_dir / stored_name
        f.save(stored_path)

        rec = get_index().add(
            original_name=f.filename,
            stored_name=stored_name,
            stored_path=str(stored_path),
            size=int(stored_path.stat().st_size),
            mime=f.mimetype or ""
        )
        created.append(rec)

    return jsonify({"success": True, "files": created})


@files_bp.route('/<file_id>', methods=['DELETE'])
def delete_file(file_id: str):
    rec = get_index().get(file_id)
    if not rec:
        return jsonify({"success": False, "error": "文件不存在"}), 404

    # 删除物理文件（如果存在）
    try:
        p = Path(rec.get('stored_path', ''))
        if p.exists() and p.is_file():
            p.unlink()
    except Exception:
        pass

    ok = get_index().delete(file_id)
    return jsonify({"success": True}) if ok else (jsonify({"success": False, "error": "删除失败"}), 500)


@files_bp.route('/<file_id>/download', methods=['GET'])
def download_file(file_id: str):
    rec = get_index().get(file_id)
    if not rec:
        return jsonify({"success": False, "error": "文件不存在"}), 404

    upload_dir = Path(current_app.config['UPLOAD_FOLDER'])
    stored_name = rec.get('stored_name')
    if not stored_name:
        return jsonify({"success": False, "error": "文件记录不完整"}), 500

    return send_from_directory(upload_dir, stored_name, as_attachment=True, download_name=rec.get('original_name') or stored_name)


@files_bp.route('/validate', methods=['POST'])
def validate_files():
    """
    Validate that file IDs exist
    
    Request Body:
        {
            "file_ids": ["id1", "id2", ...]
        }
    
    Response:
        {
            "success": true,
            "valid": ["id1"],
            "invalid": ["id2"]
        }
    """
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "error": "缺少请求体"}), 400
    
    file_ids = data.get('file_ids', [])
    if not isinstance(file_ids, list):
        return jsonify({"success": False, "error": "file_ids 必须是数组"}), 400
    
    valid = []
    invalid = []
    
    for fid in file_ids:
        if get_index().get(fid):
            valid.append(fid)
        else:
            invalid.append(fid)
    
    return jsonify({
        "success": True,
        "valid": valid,
        "invalid": invalid
    })
