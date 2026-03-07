# -*- coding: utf-8 -*-
"""工作流 API。"""

from flask import Blueprint, request, jsonify

from services.workflow_service import WorkflowServiceError, get_workflow_service

workflow_bp = Blueprint('workflows', __name__, url_prefix='/api/workflows')


@workflow_bp.route('', methods=['GET'])
def list_workflows():
    items = get_workflow_service().list_workflows()
    return jsonify({'success': True, 'workflows': items})


@workflow_bp.route('/<workflow_id>', methods=['GET'])
def get_workflow(workflow_id: str):
    try:
        workflow = get_workflow_service().get_workflow(workflow_id)
        return jsonify({'success': True, 'workflow': workflow})
    except WorkflowServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code


@workflow_bp.route('', methods=['POST'])
def save_workflow():
    try:
        workflow = get_workflow_service().save_workflow(request.json or {})
        return jsonify({'success': True, 'workflow': workflow})
    except WorkflowServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code


@workflow_bp.route('/<workflow_id>', methods=['DELETE'])
def delete_workflow(workflow_id: str):
    try:
        get_workflow_service().delete_workflow(workflow_id)
        return jsonify({'success': True})
    except WorkflowServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code


@workflow_bp.route('/<workflow_id>/run', methods=['POST'])
def run_workflow(workflow_id: str):
    payload = request.json or {}
    initial_inputs = payload.get('initial_inputs') or {}

    try:
        result = get_workflow_service().run_workflow(workflow_id, initial_inputs)
        return jsonify(result)
    except WorkflowServiceError as error:
        return jsonify({'success': False, 'error': error.message}), error.status_code
