/**
 * HTTP请求基础服务
 */

// API基础URL
const BASE_URL = 'http://localhost:5000';

async function parseResponse(response) {
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = text;
    }
  }

  if (!response.ok) {
    const message = (data && typeof data === 'object' && (data.message || data.error))
      ? (data.message || data.error)
      : `请求失败: ${response.status}`;
    throw new Error(message);
  }

  return data;
}

/**
 * 通用GET请求方法
 * @param {string} url - 请求路径
 * @returns {Promise<any>} - 响应数据
 */
async function get(url) {
  try {
    const response = await fetch(`${BASE_URL}${url}`);
    return await parseResponse(response);
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
    return await parseResponse(response);
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
    return await parseResponse(response);
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
    return await parseResponse(response);
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
    return await parseResponse(response);
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
    return await parseResponse(response);
  } catch (error) {
    console.error('API请求错误:', error);
    throw error;
  }
}

export { get, post, postFormData, put, patch, del };
