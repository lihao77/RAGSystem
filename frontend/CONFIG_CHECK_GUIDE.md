# 前端配置检查功能使用指南

## 📋 功能概述

系统现在支持自动检查配置状态，在用户访问需要配置的页面时：
1. ✅ 自动检测缺失的配置项
2. ✅ 弹出友好的提示对话框
3. ✅ 提供跳转到配置页面的选项
4. ✅ 缓存配置状态，避免频繁检查

---

## 🎯 自动配置检查（路由守卫）

### 使用方式

在路由配置中添加 `requiresConfig` meta 字段：

```javascript
// frontend/src/router/index.js

const routes = [
  {
    path: '/graphrag',
    name: 'graphrag',
    component: () => import('../views/GraphRAGView.vue'),
    meta: { 
      title: 'GraphRAG 问答',
      requiresConfig: { 
        neo4j: true,   // 需要 Neo4j 配置
        llm: true      // 需要 LLM 配置
      }
    }
  },
  {
    path: '/vector',
    name: 'vector',
    component: () => import('../views/VectorManagement.vue'),
    meta: { 
      title: '向量库管理',
      requiresConfig: { 
        vector: true   // 需要向量数据库配置
      }
    }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { 
      title: '系统配置'
      // 不需要配置检查
    }
  }
]
```

### 配置项说明

| 配置项 | 说明 | 检查内容 |
|--------|------|---------|
| `neo4j: true` | 需要 Neo4j 数据库 | URI、用户名、密码是否配置 |
| `vector: true` | 需要向量数据库 | 本地模型或远程 API 是否配置 |
| `llm: true` | 需要 LLM API | API 端点和密钥是否配置 |

### 用户体验

**未配置时访问页面：**

```
┌────────────────────────────────────────┐
│     ⚠️  系统配置不完整                   │
├────────────────────────────────────────┤
│                                        │
│ 访问"GraphRAG 问答"需要以下配置：        │
│                                        │
│ • Neo4j 数据库                         │
│ • LLM API                              │
│                                        │
│ 是否立即前往配置页面？                   │
│                                        │
│    [ 取消 ]        [ 前往配置 ]         │
└────────────────────────────────────────┘
```

**点击"前往配置"** → 自动跳转到 `/settings`  
**点击"取消"** → 停留在当前页面

---

## 🔧 手动配置检查（组件内使用）

### 基本用法

```vue
<script setup>
import { useConfigCheck } from '@/composables/useConfigCheck'

const { requireConfig } = useConfigCheck()

// 在执行操作前检查配置
async function handleAction() {
  // 检查是否已配置 Neo4j 和 LLM
  const isConfigured = await requireConfig({ 
    neo4j: true, 
    llm: true 
  })
  
  if (!isConfigured) {
    // 用户取消或未配置，停止操作
    return
  }
  
  // 配置完整，继续操作
  console.log('开始执行操作...')
}
</script>

<template>
  <el-button @click="handleAction">
    执行操作
  </el-button>
</template>
```

### 快速检查单个服务

```vue
<script setup>
import { useConfigCheck } from '@/composables/useConfigCheck'

const { checkNeo4j, checkVector, checkLLM } = useConfigCheck()

async function initPage() {
  // 检查 Neo4j 是否配置
  const hasNeo4j = await checkNeo4j()
  if (!hasNeo4j) {
    console.log('Neo4j 未配置')
    return
  }
  
  // 检查向量库是否配置
  const hasVector = await checkVector()
  if (!hasVector) {
    console.log('向量库未配置')
    return
  }
  
  // 检查 LLM 是否配置
  const hasLLM = await checkLLM()
  if (!hasLLM) {
    console.log('LLM 未配置')
    return
  }
  
  // 全部配置完成
  console.log('所有配置就绪')
}
</script>
```

### 获取详细状态

```vue
<script setup>
import { ref, onMounted } from 'vue'
import { useConfigCheck } from '@/composables/useConfigCheck'

const { checkConfigStatus } = useConfigCheck()
const configStatus = ref(null)

onMounted(async () => {
  // 获取完整的配置状态
  configStatus.value = await checkConfigStatus()
  
  console.log('Neo4j 配置状态:', configStatus.value.neo4jConfigured)
  console.log('向量库配置状态:', configStatus.value.vectorConfigured)
  console.log('LLM 配置状态:', configStatus.value.llmConfigured)
  console.log('服务列表:', configStatus.value.services)
})
</script>

<template>
  <div v-if="configStatus">
    <el-tag :type="configStatus.neo4jConfigured ? 'success' : 'danger'">
      Neo4j: {{ configStatus.neo4jConfigured ? '已配置' : '未配置' }}
    </el-tag>
    <el-tag :type="configStatus.vectorConfigured ? 'success' : 'danger'">
      向量库: {{ configStatus.vectorConfigured ? '已配置' : '未配置' }}
    </el-tag>
    <el-tag :type="configStatus.llmConfigured ? 'success' : 'danger'">
      LLM: {{ configStatus.llmConfigured ? '已配置' : '未配置' }}
    </el-tag>
  </div>
</template>
```

### 刷新配置状态

```vue
<script setup>
import { useConfigCheck } from '@/composables/useConfigCheck'

const { checkConfigStatus, resetConfigStatusCache } = useConfigCheck()

// 强制刷新配置状态（跳过缓存）
async function refreshConfig() {
  const status = await checkConfigStatus(true)  // force refresh
  console.log('配置已刷新:', status)
}

// 清除缓存
function clearCache() {
  resetConfigStatusCache()
  console.log('配置缓存已清除')
}
</script>
```

---

## 📊 API 参考

### `useConfigCheck()` 返回的方法

#### `requireConfig(requirements)`
检查配置要求，未满足时弹出确认对话框。

**参数：**
```javascript
{
  neo4j: boolean,   // 是否需要 Neo4j
  vector: boolean,  // 是否需要向量数据库
  llm: boolean      // 是否需要 LLM
}
```

**返回：** `Promise<boolean>` - 是否已配置

**示例：**
```javascript
const isOk = await requireConfig({ neo4j: true, llm: true })
if (isOk) {
  // 配置完整，执行操作
}
```

---

#### `checkConfigStatus(forceRefresh)`
获取完整的配置状态。

**参数：**
- `forceRefresh`: `boolean` - 是否强制刷新（跳过缓存）

**返回：** `Promise<Object>`
```javascript
{
  checked: true,
  neo4jConfigured: true,
  vectorConfigured: false,
  llmConfigured: true,
  lastCheckTime: 1703001234567,
  services: [...]
}
```

---

#### `checkNeo4j()` / `checkVector()` / `checkLLM()`
快速检查单个服务是否配置。

**返回：** `Promise<boolean>`

**示例：**
```javascript
if (await checkNeo4j()) {
  console.log('Neo4j 已配置')
}
```

---

#### `checkAllConfigured()`
检查所有服务是否都已配置。

**返回：** `Promise<boolean>`

**示例：**
```javascript
if (await checkAllConfigured()) {
  console.log('所有配置都已完成')
}
```

---

#### `resetConfigStatusCache()`
清除配置状态缓存，下次检查将重新请求。

**示例：**
```javascript
resetConfigStatusCache()
// 下次 checkConfigStatus() 会重新请求后端
```

---

## 🎨 自定义提示样式

如果需要自定义提示对话框的样式，可以修改 `useConfigCheck.js`：

```javascript
await ElMessageBox.confirm(
  message,
  title,
  {
    type: 'warning',
    confirmButtonText: '前往配置',
    cancelButtonText: '取消',
    distinguishCancelAndClose: true,
    closeOnClickModal: false,
    center: true,
    customClass: 'config-check-dialog',  // 自定义 CSS 类
    iconClass: 'el-icon-warning'          // 自定义图标
  }
)
```

---

## 🔄 配置更新流程

1. **用户保存配置** → 前端调用 `/api/config/`
2. **前端清除缓存** → 调用 `resetConfigStatusCache()`
3. **重新初始化服务** → 调用 `/api/config/services/xxx/reinit`
4. **下次访问页面** → 自动检查新配置状态

---

## 💡 最佳实践

### 1. 页面初始化时检查

```vue
<script setup>
import { onMounted } from 'vue'
import { useConfigCheck } from '@/composables/useConfigCheck'

const { requireConfig } = useConfigCheck()

onMounted(async () => {
  // 页面加载时立即检查
  const isConfigured = await requireConfig({ 
    neo4j: true 
  })
  
  if (!isConfigured) {
    // 未配置，可以显示占位内容
    return
  }
  
  // 配置完整，加载数据
  loadData()
})
</script>
```

### 2. 按钮点击时检查

```vue
<script setup>
import { useConfigCheck } from '@/composables/useConfigCheck'

const { requireConfig } = useConfigCheck()

async function executeAction() {
  // 执行前检查
  if (!await requireConfig({ llm: true })) {
    return
  }
  
  // 执行操作
  await doSomething()
}
</script>

<template>
  <el-button @click="executeAction">
    执行 AI 操作
  </el-button>
</template>
```

### 3. 显示配置状态指示器

```vue
<script setup>
import { ref, onMounted } from 'vue'
import { useConfigCheck } from '@/composables/useConfigCheck'

const { checkConfigStatus } = useConfigCheck()
const status = ref(null)

onMounted(async () => {
  status.value = await checkConfigStatus()
})
</script>

<template>
  <div class="config-indicators">
    <el-badge 
      :value="status?.neo4jConfigured ? '✓' : '✗'" 
      :type="status?.neo4jConfigured ? 'success' : 'danger'">
      Neo4j
    </el-badge>
    <el-badge 
      :value="status?.vectorConfigured ? '✓' : '✗'" 
      :type="status?.vectorConfigured ? 'success' : 'danger'">
      向量库
    </el-badge>
    <el-badge 
      :value="status?.llmConfigured ? '✓' : '✗'" 
      :type="status?.llmConfigured ? 'success' : 'danger'">
      LLM
    </el-badge>
  </div>
</template>
```

---

## ✅ 已配置的路由

| 路由 | 需要的配置 | 说明 |
|------|-----------|------|
| `/` (首页) | Neo4j | 显示图谱统计信息 |
| `/split` | Neo4j | 综合视图 |
| `/search` | Neo4j | 实体查询 |
| `/graphrag` | Neo4j + LLM | GraphRAG 问答 |
| `/vector` | 向量数据库 | 向量库管理 |
| `/workflow` | Neo4j | 工作流编排 |
| `/settings` | - | 系统配置（无需检查）|
| `/nodes` | - | 节点系统（无需检查）|
| `/files` | - | 文件管理（无需检查）|

---

## 🐛 故障排除

### 问题：配置检查不生效

**检查：**
1. 确认路由 meta 中有 `requiresConfig` 字段
2. 确认 `useConfigCheck.js` 已正确导入
3. 查看浏览器控制台是否有错误

### 问题：缓存未更新

**解决：**
```javascript
import { resetConfigStatusCache } from '@/composables/useConfigCheck'

// 清除缓存
resetConfigStatusCache()

// 或强制刷新
const status = await checkConfigStatus(true)
```

### 问题：提示对话框不显示

**检查：**
1. 确认 Element Plus 已正确安装
2. 确认 `ElMessageBox` 已导入
3. 查看浏览器控制台是否有错误

---

## 📝 总结

现在系统已经支持：
- ✅ 路由级别的自动配置检查
- ✅ 组件内手动配置检查
- ✅ 友好的用户提示和引导
- ✅ 配置状态缓存和刷新
- ✅ 灵活的 API 和多种使用方式

用户在访问任何需要配置的页面时，都会得到友好的提示和引导！🎉
