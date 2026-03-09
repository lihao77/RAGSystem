# -*- coding: utf-8 -*-
"""
Agent 会话与恢复相关路由。
"""

from .shared import (
    agent_bp,
    error_response,
    get_collaboration_application,
    get_session_application,
    logger,
    request,
    success_response,
)

@agent_bp.route('/sessions', methods=['POST'])
def create_session():
    try:
        data = request.get_json() or {}
        user_id = data.get('user_id')
        metadata = data.get('metadata') or {}
        session_id = data.get('session_id')
        if not session_id:
            import uuid
            session_id = str(uuid.uuid4())

        return success_response(
            data=get_session_application().create_session(
                session_id=session_id,
                user_id=user_id,
                metadata=metadata,
            ),
            message='会话创建成功'
        )
    except Exception as e:
        logger.error(f'创建会话失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions', methods=['GET'])
def list_sessions():
    try:
        limit = int(request.args.get('limit', 20))
        offset = int(request.args.get('offset', 0))
        user_id = request.args.get('user_id')
        if user_id is not None and str(user_id).strip() == "":
            user_id = None
        data = get_session_application().list_sessions(limit=limit, offset=offset, user_id=user_id)
        return success_response(data=data, message='获取会话列表成功')
    except Exception as e:
        logger.error(f'获取会话列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>', methods=['GET'])
def get_session(session_id):
    try:
        session = get_session_application().get_session(session_id)
        if not session:
            return error_response(message='会话不存在', status_code=404)
        return success_response(data=session, message='获取会话成功')
    except Exception as e:
        logger.error(f'获取会话失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>', methods=['DELETE'])
def delete_session(session_id):
    """删除会话及其所有消息"""
    try:
        if not get_session_application().delete_session(session_id):
            return error_response(message='会话不存在', status_code=404)

        return success_response(message='会话删除成功')
    except Exception as e:
        logger.error(f'删除会话失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>/recover', methods=['POST'])
def recover_session(session_id):
    """
    从检查点恢复会话执行

    Body:
        {
            "checkpoint_id": "xxx",  // 可选，不指定则使用最新检查点
            "agent_name": "qa_agent"  // 可选，指定智能体
        }

    Returns:
        {
            "success": true,
            "data": {
                "checkpoint_id": "xxx",
                "round": 3,
                "answer": "...",
                "success": true
            }
        }
    """
    try:
        data = get_collaboration_application().recover_session(session_id, request.get_json() or {})
        return success_response(
            data=data,
            message='从检查点恢复成功' if data.get('success') else '恢复执行完成但未成功'
        )
    except LookupError as e:
        return error_response(message=str(e), status_code=404)
    except ValueError as e:
        return error_response(message=str(e), status_code=400)
    except Exception as e:
        logger.error(f'从检查点恢复失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>/checkpoints', methods=['GET'])
def list_session_checkpoints(session_id):
    """
    列出会话的检查点

    Query Parameters:
        agent_name: 智能体名称（可选）
        limit: 返回数量限制（默认 10）

    Returns:
        {
            "success": true,
            "data": {
                "checkpoints": [...]
            }
        }
    """
    try:
        return success_response(
            data=get_collaboration_application().list_checkpoints(
                session_id,
                agent_name=request.args.get('agent_name'),
                limit=int(request.args.get('limit', 10)),
            ),
            message='获取检查点列表成功'
        )

    except Exception as e:
        logger.error(f'获取检查点列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>/rollback', methods=['POST'])
def rollback_session(session_id):
    """
    回退到某条消息：删除该条之后的所有消息及关联 run_steps。
    Body: { "after_seq": 5 } 或 { "after_message_id": "uuid" }
    """
    try:
        data = request.get_json() or {}
        after_seq = data.get('after_seq')
        after_message_id = data.get('after_message_id')
        if after_seq is None and not after_message_id:
            return error_response(message='请提供 after_seq 或 after_message_id', status_code=400)
        if after_seq is not None and not isinstance(after_seq, int):
            try:
                after_seq = int(after_seq)
            except (TypeError, ValueError):
                return error_response(message='after_seq 须为整数', status_code=400)
        deleted = get_session_application().rollback_messages(
            session_id=session_id,
            after_seq=after_seq,
            after_message_id=after_message_id,
        )
        return success_response(data={'deleted': deleted}, message='回退成功')
    except Exception as e:
        logger.error(f'回退失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>/rollback-and-retry', methods=['POST'])
def rollback_and_retry(session_id):
    """
    回退到某条消息并自动重试：删除该条之后的消息，使用原问题或修改后的问题重新执行。

    Body: {
        "after_seq": 5,                      # 回退到第 5 条（该条保留，之后删除）
        "modify_user_message": "新问题",      # 可选：修改用户问题后重试
        "user_id": "xxx"                     # 可选：用户 ID
    }
    要求 after_seq 对应的消息必须是 user 角色。
    """
    try:
        data = request.get_json() or {}
        after_seq = data.get('after_seq')
        if after_seq is None:
            return error_response(message='请提供 after_seq', status_code=400)
        try:
            after_seq = int(after_seq)
        except (TypeError, ValueError):
            return error_response(message='after_seq 须为整数', status_code=400)

        result = get_collaboration_application().rollback_and_retry(session_id, data)
        return success_response(
            data=result,
            message='重试成功' if result.get('success') else '重试执行完成但未得到成功结果'
        )
    except LookupError as e:
        return error_response(message=str(e), status_code=404)
    except ValueError as e:
        return error_response(message=str(e), status_code=400)
    except Exception as e:
        logger.error(f'回退并重试失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>/messages/<message_id>', methods=['PATCH'])
def update_session_message(session_id, message_id):
    """
    更新某条消息内容（主要用于编辑 user 消息）。
    Body: { "content": "新内容" }
    """
    try:
        data = request.get_json() or {}
        content = data.get('content')
        if content is None:
            return error_response(message='请提供 content', status_code=400)
        if not get_session_application().update_user_message(
            session_id=session_id,
            message_id=message_id,
            content=content,
        ):
            return error_response(message='消息不存在或不可编辑', status_code=404)
        return success_response(data={'message_id': message_id}, message='更新成功')
    except Exception as e:
        logger.error(f'更新消息失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>/messages', methods=['GET'])
def get_session_messages(session_id):
    try:
        limit = int(request.args.get('limit', 20))
        offset = int(request.args.get('offset', 0))
        expand = request.args.get('expand', 'steps').lower()
        expand_steps = expand in ('1', 'true', 'steps', 'yes')
        data = get_session_application().list_messages(
            session_id=session_id,
            limit=limit,
            offset=offset,
            expand_steps=expand_steps,
        )
        return success_response(data=data, message='获取对话记录成功')
    except Exception as e:
        logger.error(f'获取对话记录失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)
