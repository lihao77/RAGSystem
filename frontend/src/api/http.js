/**
 * HTTP请求基础服务
 */

// API基础URL
const BASE_URL = 'http://10.24.250.158:5000';

/**
 * 通用GET请求方法
 * @param {string} url - 请求路径
 * @returns {Promise<any>} - 响应数据
 */
async function get(url) {
  try {
    const response = await fetch(`${BASE_URL}${url}`);
    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('API请求错误:', error);
    throw error;
  }
}

/**
 * 通用POST请求方法
 * @param {string} url - 请求路径
 * @param {object} data - 请求数据
 * @returns {Promise<any>} - 响应数据
 */
async function post(url, data) {
  try {
    const response = await fetch(`${BASE_URL}${url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    const res = await response.json();
    if (!response.ok) {
      
      throw new Error(res.message || res.error || `请求失败: ${response.status}`);
    }
    return res;
  } catch (error) {
    console.error('API请求错误:', error);
    throw error;
  }
}

/**
 * 文件上传POST请求方法
 * @param {string} url - 请求路径
 * @param {FormData} formData - 包含文件的FormData对象
 * @returns {Promise<any>} - 响应数据
 */
async function postFormData(url, formData) {
  try {
    const response = await fetch(`${BASE_URL}${url}`, {
      method: 'POST',
      body: formData // 直接使用FormData，不进行JSON序列化
    });
    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('API请求错误:', error);
    throw error;
  }
}

/**
 *  通用PUT请求方法
 * @param {string} url - 请求路径
 * @param {object} data - 请求数据
 * @returns {Promise<any>} - 响应数据
 */
async function put(url, data) {
  try {
    const response = await fetch(`${BASE_URL}${url}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('API请求错误:', error);
    throw error;
  }
}

/**
 * 通用PATCH请求方法
 * @param {string} url - 请求路径
 * @param {object} data - 请求数据
 * @returns {Promise<any>} - 响应数据
 */
async function patch(url, data) {
  try {
    const response = await fetch(`${BASE_URL}${url}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('API请求错误:', error);
    throw error;
  }
}

/**
 * 通用DELETE请求方法
 * @param {string} url - 请求路径
 * @returns {Promise<any>} - 响应数据
 */
async function del(url) {
  try {
    const response = await fetch(`${BASE_URL}${url}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('API请求错误:', error);
    throw error;
  }
}

export { get, post, postFormData, put, patch, del };