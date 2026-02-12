/**
 * 处理 Embedding 索引错误的示例代码
 * 
 * 在前端调用索引 API 时，可以根据返回的错误类型和详情，
 * 精准定位问题并给出用户友好的提示。
 */

// API 调用示例
async function indexDocument(text, documentId, collectionName = 'documents') {
  try {
    const response = await fetch('/api/vector/index', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        document_id: documentId,
        collection_name: collectionName,
        chunk_size: 500,
        overlap: 50
      })
    });

    const data = await response.json();

    if (!data.success) {
      // 处理结构化错误
      handleEmbeddingError(data.error);
      return null;
    }

    return data.data;
  } catch (error) {
    console.error('网络错误:', error);
    showNotification('网络连接失败，请检查网络', 'error');
    return null;
  }
}

// 错误处理函数
function handleEmbeddingError(error) {
  // 旧版错误格式兼容
  if (typeof error === 'string') {
    showNotification(error, 'error');
    return;
  }

  const { type, message, details } = error;

  switch (type) {
    case 'content_policy_violation':
      // 敏感词/内容审核错误
      showContentPolicyDialog(message, details);
      break;

    case 'authentication_error':
      // 认证错误
      showNotification('API 密钥无效或已过期，请检查配置', 'error');
      break;

    case 'rate_limit':
      // 配额/限流错误
      showNotification('API 调用频率超限，请稍后再试', 'warning');
      break;

    case 'model_error':
      // 模型错误
      showNotification(`模型错误: ${message}`, 'error');
      break;

    case 'bad_request':
      // 请求格式错误
      showNotification(`请求格式错误: ${message}`, 'error');
      break;

    case 'server_error':
      // 服务端错误
      showNotification('Embedding 服务暂时不可用，请稍后重试', 'error');
      break;

    case 'connection_error':
      // 连接错误
      showNotification('无法连接到 Embedding 服务，请检查网络', 'error');
      break;

    default:
      // 未知错误
      showNotification(`索引失败: ${message}`, 'error');
  }

  // 控制台输出详细错误信息（用于调试）
  console.error('Embedding Error:', { type, message, details });
}

// 敏感词错误详情对话框
function showContentPolicyDialog(message, details) {
  const statusCode = details?.status_code || 400;
  const response = details?.response || {};
  
  // 尝试提取 provider 返回的具体敏感词信息
  let sensitiveInfo = '';
  
  // 常见的 provider 错误格式
  if (response.error?.message) {
    sensitiveInfo = response.error.message;
  } else if (response.message) {
    sensitiveInfo = response.message;
  } else if (typeof response === 'string') {
    sensitiveInfo = response;
  }

  // 构建用户友好的提示
  const dialogContent = `
    <div class="error-dialog">
      <h3>内容安全警告</h3>
      <p>文档中包含不符合提供商内容政策的内容，无法建立索引。</p>
      
      ${sensitiveInfo ? `
        <div class="error-details">
          <strong>详细信息：</strong>
          <pre>${escapeHtml(sensitiveInfo)}</pre>
        </div>
      ` : ''}
      
      <div class="error-suggestions">
        <strong>建议：</strong>
        <ul>
          <li>检查文档中是否包含敏感词汇或不当内容</li>
          <li>尝试分段索引，定位具体有问题的内容</li>
          <li>联系管理员调整 Embedding provider 的内容审核设置</li>
          <li>更换其他 Embedding provider</li>
        </ul>
      </div>
    </div>
  `;

  // 显示对话框（使用 Element Plus 或其他 UI 框架）
  showDialog(dialogContent, 'warning');
}

// 辅助函数
function showNotification(message, type = 'info') {
  // 使用 Element Plus Message 组件
  if (window.ElementPlus) {
    ElementPlus.ElMessage({
      message,
      type,
      duration: 5000,
      showClose: true
    });
  } else {
    alert(message);
  }
}

function showDialog(content, type = 'info') {
  if (window.ElementPlus) {
    ElementPlus.ElMessageBox.alert(content, '错误详情', {
      confirmButtonText: '确定',
      type,
      dangerouslyUseHTMLString: true
    });
  } else {
    alert(content.replace(/<[^>]*>/g, ''));
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Vue 3 Composition API 示例
import { ref } from 'vue';

export function useVectorIndex() {
  const indexing = ref(false);
  const errorInfo = ref(null);

  const indexDocument = async (text, documentId) => {
    indexing.value = true;
    errorInfo.value = null;

    try {
      const response = await fetch('/api/vector/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, document_id: documentId })
      });

      const data = await response.json();

      if (!data.success) {
        errorInfo.value = data.error;
        
        // 根据错误类型提供不同的用户引导
        if (data.error.type === 'content_policy_violation') {
          // 显示敏感词详情和分段索引选项
          return {
            success: false,
            canRetry: true,
            retryStrategy: 'chunk_by_chunk',
            error: data.error
          };
        }
        
        throw new Error(data.error.message);
      }

      return { success: true, data: data.data };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      indexing.value = false;
    }
  };

  // 分段索引功能：逐个分块索引，定位问题内容
  const indexDocumentChunkByChunk = async (text, documentId) => {
    // 先分块
    const chunks = splitIntoChunks(text, 500, 50);
    const failedChunks = [];
    const successCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${documentId}_chunk_${i}`;
      
      try {
        await indexDocument(chunks[i], chunkId);
        successCount++;
      } catch (error) {
        failedChunks.push({
          index: i,
          text: chunks[i].substring(0, 100) + '...',
          error: error.message
        });
      }
    }

    return {
      success: failedChunks.length === 0,
      totalChunks: chunks.length,
      successCount,
      failedChunks
    };
  };

  return {
    indexing,
    errorInfo,
    indexDocument,
    indexDocumentChunkByChunk
  };
}

// 简单的分块函数（示例）
function splitIntoChunks(text, chunkSize, overlap) {
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }
  
  return chunks;
}

export default {
  indexDocument,
  handleEmbeddingError,
  useVectorIndex
};
