# -*- coding: utf-8 -*-
"""
Tool executor 共享依赖。
"""

from services.query_service import get_query_service
from utils.neo4j_helpers import convert_neo4j_types
from db import get_session
from services.cypher_generator import get_cypher_generator, generate_answer_from_query_results
from tools.response_builder import success_response, error_response


def get_graph_schema():
    return get_query_service().get_graph_schema()


def execute_cypher(cypher):
    return get_query_service().execute_cypher(cypher)


__all__ = [
    'get_session',
    'get_graph_schema',
    'execute_cypher',
    'convert_neo4j_types',
    'get_cypher_generator',
    'generate_answer_from_query_results',
    'success_response',
    'error_response',
]
