/**
 * GraphRAG服务 - 基于知识图谱的智能问答
 */

import { get, post } from './http';

/**
 * 获取图谱结构
 */
export const getGraphSchema = () => {
  return get('/api/graphrag/schema');
};

/**
 * 提交问题并获取回答
 * @param {string} question - 用户问题
 * @param {Array} history - 对话历史
 */
export const queryGraphRAG = (question, history = []) => {
  return post('/api/graphrag/query', {
    question,
    history
  });
};

/**
 * 执行自定义Cypher查询
 * @param {string} cypher - Cypher查询语句
 */
export const executeCypher = (cypher) => {
  return post('/api/graphrag/cypher/execute', {
    cypher
  });
};
