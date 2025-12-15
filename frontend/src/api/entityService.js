/**
 * 实体相关API服务
 */
import { get } from './http';

/**
 * 获取实体关系数据
 * @returns {Promise<object>} 实体关系数据
 */
export function getEntityRelationships() {
  return get('/api/visualization/entity-relationships');
}

/**
 * 获取知识图谱数据
 * @returns {Promise<object>} 知识图谱数据
 */
export function getKnowledgeGraph() {
  return get('/api/visualization/knowledge-graph');
}

/**
 * 获取实体详情
 * @param {string} entityId - 实体ID
 * @returns {Promise<object>} 实体详情
 */
export function getEntityById(entityId) {
  return get(`/api/visualization/entities/${entityId}`);
}

/**
 * 获取实体的状态链
 * @param {string} entityId - 实体ID
 * @returns {Promise<object>} 状态链数据
 */
export function getEntityStates(entityId) {
  return get(`/api/visualization/entity-states/${entityId}`);
}

/**
 * 获取与实体相关的事件
 * @param {string} entityId - 实体ID
 * @returns {Promise<Array>} 相关事件列表
 */
export function getEntityEvents(entityId) {
  return get(`/api/visualization/entity-events/${entityId}`);
}

/**
 * 获取与实体相关的设施
 * @param {string} entityId - 实体ID
 * @returns {Promise<Array>} 相关设施列表
 */
export function getEntityFacilities(entityId) {
  return get(`/api/visualization/entity-facilities/${entityId}`);
}

/**
 * 获取事件发生地点
 * @param {string} eventId - 事件ID
 * @returns {Promise<object>} 事件地点数据
 */
export function getEventLocations(eventId) {
  return get(`/api/visualization/event-locations/${eventId}`);
}

/**
 * 获取地点层级结构
 * @param {string} locationId - 地点ID
 * @returns {Promise<object>} 地点层级结构数据
 */
export function getLocationHierarchy(locationId) {
  return get(`/api/visualization/location-hierarchy/${locationId}`);
}

/**
 * 获取状态详情
 * @param {string} stateId - 状态ID
 * @returns {Promise<object>} 状态详情数据
 */
export function getStateDetails(stateId) {
    return get(`/api/visualization/state-details/${stateId}`);
  }