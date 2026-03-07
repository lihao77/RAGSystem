# -*- coding: utf-8 -*-
"""
首页服务层。
"""

from __future__ import annotations

from runtime.dependencies import get_runtime_dependency
from typing import Any, Dict, Optional

from db import get_session


class HomeService:
    """封装首页统计和最近文档逻辑。"""

    def __init__(self, session_factory=None, documents=None):
        self._session_factory = session_factory or get_session
        self._documents = documents or [
            {'id': '1', 'name': '2023年广西水旱灾害公报.docx', 'date': '2023-12-15'},
            {'id': '2', 'name': '2022年广西水旱灾害公报.docx', 'date': '2023-12-14'},
            {'id': '3', 'name': '2021年广西水旱灾害公报.docx', 'date': '2023-12-13'},
            {'id': '4', 'name': '2020年广西水旱灾害公报.docx', 'date': '2023-12-12'},
        ]

    def get_stats(self) -> Dict[str, Any]:
        session = self._session_factory()
        try:
            node_query = """
            OPTIONAL MATCH (a:Attribute)
            WITH count(a) AS Attribute
            OPTIONAL MATCH (s:State)
            WITH Attribute, count(s) AS State
            OPTIONAL MATCH (e:事件)
            WITH Attribute, State, count(e) AS Event
            OPTIONAL MATCH (l:地点)
            WITH Attribute, State, Event, count(l) AS Location
            OPTIONAL MATCH (f:设施)
            RETURN Attribute, State, Event, Location, count(f) AS Facility
            """
            relation_query = """
            OPTIONAL MATCH ()-[r:contain]->()
            WITH count(r) AS contain
            OPTIONAL MATCH ()-[r:hasAttribute]->()
            WITH contain, count(r) AS hasAttribute
            OPTIONAL MATCH ()-[r:hasRelation]->()
            WITH contain, hasAttribute, count(r) AS hasRelation
            OPTIONAL MATCH ()-[r:hasState]->()
            WITH contain, hasAttribute, hasRelation, count(r) AS hasState
            OPTIONAL MATCH ()-[r:locatedIn]->()
            WITH contain, hasAttribute, hasRelation, hasState, count(r) AS locatedIn
            OPTIONAL MATCH ()-[r:nextState]->()
            WITH contain, hasAttribute, hasRelation, hasState, locatedIn, count(r) AS nextState
            OPTIONAL MATCH ()-[r:occurredAt]->()
            RETURN contain, hasAttribute, hasRelation, hasState, locatedIn, nextState, count(r) AS occurredAt
            """

            node_records = list(session.run(node_query))
            relation_records = list(session.run(relation_query))
            return {
                'nodeState': {
                    'Attribute': self._get_record_count(node_records, 'Attribute'),
                    'State': self._get_record_count(node_records, 'State'),
                    'Event': self._get_record_count(node_records, 'Event'),
                    'Location': self._get_record_count(node_records, 'Location'),
                    'Facility': self._get_record_count(node_records, 'Facility'),
                },
                'relationState': {
                    'contain': self._get_record_count(relation_records, 'contain'),
                    'hasAttribute': self._get_record_count(relation_records, 'hasAttribute'),
                    'hasRelation': self._get_record_count(relation_records, 'hasRelation'),
                    'hasState': self._get_record_count(relation_records, 'hasState'),
                    'locatedIn': self._get_record_count(relation_records, 'locatedIn'),
                    'nextState': self._get_record_count(relation_records, 'nextState'),
                    'occurredAt': self._get_record_count(relation_records, 'occurredAt'),
                },
            }
        finally:
            session.close()

    def get_recent_documents(self):
        return self._documents

    def get_document(self, document_id: str) -> Optional[Dict[str, Any]]:
        return next((doc for doc in self._documents if doc['id'] == document_id), None)

    @staticmethod
    def _get_record_count(records, key: str) -> int:
        try:
            if records and len(records) > 0:
                record = records[0]
                if key in record.keys():
                    value = record[key]
                    return int(value) if value is not None else 0
            return 0
        except Exception:
            return 0


_home_service: Optional[HomeService] = None



def get_home_service() -> HomeService:
    global _home_service
    return get_runtime_dependency(
        container_getter='get_home_service',
        fallback_name='home_service',
        fallback_factory=HomeService,
        legacy_getter=lambda: _home_service,
        legacy_setter=lambda instance: globals().__setitem__('_home_service', instance),
    )
