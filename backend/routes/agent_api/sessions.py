# -*- coding: utf-8 -*-
"""
Agent 会话与恢复相关路由。
"""

from .shared import (
    AgentContext,
    agent_bp,
    error_response,
    logger,
    request,
    success_response,
    uuid_module,
    _get_conversation_store,
    _get_orchestrator,
    _load_history_into_context,
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

        store = _get_conversation_store()
        store.create_session(session_id=session_id, user_id=user_id, metadata=metadata)

        return success_response(
            data={
                'session_id': session_id,
                'user_id': user_id,
                'metadata': metadata
            },
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
        store = _get_conversation_store()
        data = store.list_sessions(limit=limit, offset=offset, user_id=user_id)
        return success_response(data=data, message='获取会话列表成功')
    except Exception as e:
        logger.error(f'获取会话列表失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)

@agent_bp.route('/sessions/<session_id>', methods=['GET'])
def get_session(session_id):
    try:
        store = _get_conversation_store()
        session = store.get_session(session_id=session_id)
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
        store = _get_conversation_store()
        session = store.get_session(session_id=session_id)
        if not session:
            return error_response(message='会话不存在', status_code=404)

        # 删除会话（会级联删除所有消息和 run_steps）
        store.delete_session(session_id=session_id)

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
        from agents.recovery import CheckpointManager

        data = request.get_json() or {}
        checkpoint_id = data.get('checkpoint_id')
        agent_name = data.get('agent_name')

        # 初始化检查点管理器
        checkpoint_manager = CheckpointManager()

        # 加载检查点
        if checkpoint_id:
            checkpoint = checkpoint_manager.load_checkpoint(checkpoint_id)
        else:
            checkpoint = checkpoint_manager.get_latest_checkpoint(
                session_id=session_id,
                agent_name=agent_name
            )

        if not checkpoint:
            return error_response(
                message='未找到可用的检查点',
                status_code=404
            )

        logger.info(f"从检查点恢复: {checkpoint['checkpoint_id']}, 轮次: {checkpoint['round']}")

        # 重建上下文
        orchestrator = _get_orchestrator()
        context = AgentContext(
            session_id=session_id,
            user_id=data.get('user_id')
        )

        # 恢复消息历史
        for msg in checkpoint['messages']:
            context.add_message(
                role=msg['role'],
                content=msg['content'],
                metadata=msg.get('metadata', {})
            )

        # 获取最后一条用户消息作为任务
        user_messages = [m for m in checkpoint['messages'] if m['role'] == 'user']
        if not user_messages:
            return error_response(
                message='检查点中没有用户消息',
                status_code=400
            )

        task = user_messages[-1]['content']

        # 继续执行
        response = orchestrator.execute(
            task=task,
            context=context,
            agent_name=checkpoint['agent_name']
        )

        # 保存结果
        store = _get_conversation_store()
        if response.success and response.content:
            store.add_message(
                session_id=session_id,
                role='assistant',
                content=response.content,
                metadata={
                    'agent': response.agent_name,
                    'recovered_from': checkpoint['checkpoint_id']
                }
            )

        return success_response(
            data={
                'checkpoint_id': checkpoint['checkpoint_id'],
                'round': checkpoint['round'],
                'answer': response.content if response.success else None,
                'success': response.success,
                'error': response.error if not response.success else None,
                'agent_name': response.agent_name
            },
            message='从检查点恢复成功' if response.success else '恢复执行完成但未成功'
        )

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
        from agents.recovery import CheckpointManager

        agent_name = request.args.get('agent_name')
        limit = int(request.args.get('limit', 10))

        checkpoint_manager = CheckpointManager()
        checkpoints = checkpoint_manager.list_checkpoints(
            session_id=session_id,
            agent_name=agent_name,
            limit=limit
        )

        return success_response(
            data={'checkpoints': checkpoints},
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
        store = _get_conversation_store()
        deleted = store.delete_messages_after(
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

        store = _get_conversation_store()
        original_message = store.get_message_by_seq(session_id=session_id, seq=after_seq)
        if not original_message:
            return error_response(message=f'未找到会话 {session_id} 中序号为 {after_seq} 的消息', status_code=404)
        if original_message.get('role') != 'user':
            return error_response(message='指定位置必须是用户消息（user），才能从此处重试', status_code=400)

        deleted = store.delete_messages_after(session_id=session_id, after_seq=after_seq)
        task = data.get('modify_user_message')
        if task is not None:
            task = (task or '').strip()
        if not task:
            task = (original_message.get('content') or '').strip()
        if not task:
            return error_response(message='无法获取要重试的任务内容', status_code=400)

        if data.get('modify_user_message') is not None:
            store.update_message(
                message_id=original_message['id'],
                content=task,
                session_id=session_id,
                role_filter='user'
            )

        user_id = data.get('user_id')
        orchestrator = _get_orchestrator()
        context = AgentContext(session_id=session_id, user_id=user_id)
        _load_history_into_context(context, session_id=session_id, limit=50)

        response = orchestrator.execute(task=task, context=context)

        if response.success and response.content:
            store.add_message(
                session_id=session_id,
                role='assistant',
                content=response.content,
                metadata={'agent': response.agent_name}
            )

        return success_response(
            data={
                'deleted': deleted,
                'answer': response.content if response.success else None,
                'agent_name': response.agent_name if response.success else None,
                'execution_time': getattr(response, 'execution_time', None),
                'success': response.success,
                'error': response.error if not response.success else None
            },
            message='重试成功' if response.success else '重试执行完成但未得到成功结果'
        )
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
        store = _get_conversation_store()
        updated = store.update_message(
            message_id=message_id,
            content=content,
            session_id=session_id,
            role_filter='user',
        )
        if not updated:
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
        store = _get_conversation_store()
        data = store.list_messages(session_id=session_id, limit=limit, offset=offset)
        # 过滤掉 ReAct 中间消息，前端聊天界面不显示
        if data.get('items'):
            data['items'] = [
                item for item in data['items']
                if not (item.get('metadata') or {}).get('react_intermediate')
            ]
        if expand_steps and data.get('items'):
            for item in data['items']:
                if item.get('role') == 'assistant' and (item.get('metadata') or {}).get('run_id'):
                    # 按 run_id 查该 run 的全部 steps，避免 FINAL_ANSWER 之后写入的 AGENT_END/RUN_END 因 message_id 未及时更新而被漏掉
                    run_id = (item.get('metadata') or {}).get('run_id')
                    steps = store.list_run_steps(
                        run_id=run_id,
                        session_id=session_id,
                        limit=500,
                    )
                    item['steps'] = steps
        return success_response(data=data, message='获取对话记录成功')
    except Exception as e:
        logger.error(f'获取对话记录失败: {e}', exc_info=True)
        return error_response(message=str(e), status_code=500)
