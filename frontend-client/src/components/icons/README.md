# 图标组件管理系统

## 📁 目录结构

```
components/icons/
├── index.js              # 统一导出文件
├── IconLogo.vue          # Logo 图标（系统标识）
├── IconChevronLeft.vue   # 左箭头（折叠）
├── IconChevronRight.vue  # 右箭头（展开）
├── IconDocument.vue      # 文档列表图标
└── IconPlus.vue          # 加号图标
```

## 🎨 设计原则

### 1. 组件化封装
- 每个图标是一个独立的 Vue 组件
- 支持 props 动态配置（尺寸、颜色、样式）
- 可复用、易维护

### 2. 统一的 Props 接口
所有图标组件支持以下通用 props：

```javascript
{
  size: Number | String,      // 图标尺寸
  color: String,              // 颜色（默认 currentColor）
  strokeWidth: Number | String // 线条宽度
}
```

### 3. 样式继承
- 默认使用 `currentColor`，自动继承父元素颜色
- 支持 CSS 变量和主题切换
- 内置过渡动画

## 📖 使用指南

### 基础使用

```vue
<template>
  <div>
    <!-- 导入图标组件 -->
    <IconLogo :size="32" />
    <IconChevronLeft />
    <IconDocument :size="20" color="#6366f1" />
  </div>
</template>

<script setup>
import { IconLogo, IconChevronLeft, IconDocument } from '@/components/icons';
</script>
```

### IconLogo 特殊属性

Logo 图标支持额外的属性：

```vue
<IconLogo
  :size="80"
  :animated="true"    <!-- 启用数据流动动画 -->
  :simple="false"     <!-- 简化版本（移除外圈） -->
/>
```

### 在不同场景中使用

#### 1. Sidebar Logo
```vue
<IconLogo :size="32" simple />
```

#### 2. Welcome Screen
```vue
<IconLogo :size="80" animated />
```

#### 3. 历史记录列表
```vue
<IconDocument :size="18" />
```

#### 4. 按钮图标
```vue
<button>
  <IconPlus :size="20" />
  <span>New Chat</span>
</button>
```

## 🔧 添加新图标

### 步骤 1: 创建图标组件

在 `components/icons/` 创建新文件，例如 `IconSearch.vue`：

```vue
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    class="icon-search"
  >
    <!-- SVG 路径 -->
    <path
      d="M11 19C15.4183 19 19 15.4183 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19Z"
      :stroke="color"
      :stroke-width="strokeWidth"
      stroke-linecap="round"
    />
    <path
      d="M21 21L16.65 16.65"
      :stroke="color"
      :stroke-width="strokeWidth"
      stroke-linecap="round"
    />
  </svg>
</template>

<script setup>
defineProps({
  size: {
    type: [Number, String],
    default: 20
  },
  color: {
    type: String,
    default: 'currentColor'
  },
  strokeWidth: {
    type: [Number, String],
    default: 2
  }
});
</script>

<style scoped>
.icon-search {
  transition: all 0.3s ease;
}
</style>
```

### 步骤 2: 在 index.js 中导出

```javascript
export { default as IconSearch } from './IconSearch.vue';
```

### 步骤 3: 使用新图标

```vue
<script setup>
import { IconSearch } from '@/components/icons';
</script>

<template>
  <IconSearch :size="24" />
</template>
```

## 🎯 最佳实践

### 1. 命名规范
- 文件名：`Icon<Name>.vue`（PascalCase）
- class 名：`icon-<name>`（kebab-case）
- 例如：`IconChevronLeft.vue` → `icon-chevron-left`

### 2. SVG 优化
- 使用 `viewBox` 而非固定宽高
- 移除不必要的 `<g>` 标签和属性
- 使用 `currentColor` 实现颜色继承
- 保持路径数据简洁

### 3. Props 默认值
```javascript
// 推荐的默认值
size: 20-24       // 常规图标
size: 16-18       // 小图标（列表、按钮内）
size: 32-48       // 大图标（Logo、装饰性）
strokeWidth: 2    // 标准线宽
color: 'currentColor'  // 继承父元素颜色
```

### 4. 性能优化
- 避免在循环中使用复杂的渐变图标
- 使用 `simple` prop 提供简化版本
- 条件渲染动画效果（仅在需要时启用）

## 📦 与第三方图标库集成

如果需要使用更多图标，可以集成 Iconify 或 Heroicons：

### 方案 1: unplugin-icons（推荐）

```bash
npm install -D unplugin-icons @iconify/json
```

```javascript
// vite.config.js
import Icons from 'unplugin-icons/vite'

export default {
  plugins: [
    Icons({
      autoInstall: true,
    })
  ]
}
```

```vue
<script setup>
import IconCarbonHome from '~icons/carbon/home'
</script>

<template>
  <IconCarbonHome />
</template>
```

### 方案 2: 手动迁移
从 [Heroicons](https://heroicons.com/) 或 [Lucide](https://lucide.dev/) 复制 SVG，按照上述模板创建组件。

## 🔍 图标资源推荐

- **Heroicons** - https://heroicons.com/
- **Lucide** - https://lucide.dev/
- **Phosphor Icons** - https://phosphoricons.com/
- **Tabler Icons** - https://tabler-icons.io/
- **Iconify** - https://icon-sets.iconify.design/

## ✅ 优势总结

1. **类型安全** - 组件化，IDE 自动补全
2. **易于维护** - 修改一处，全局生效
3. **性能优良** - 按需加载，Tree-shaking
4. **灵活定制** - Props 控制样式，无需重复代码
5. **主题兼容** - 使用 `currentColor`，自动适配主题
6. **动画支持** - 内置过渡效果，支持自定义动画

## 📝 迁移现有代码

参考 `ChatViewV2.vue` 的迁移示例，将内联 SVG 替换为图标组件：

```vue
<!-- 迁移前 -->
<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
  <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2"/>
</svg>

<!-- 迁移后 -->
<IconChevronLeft />
```

这样可以减少 90% 的重复代码！
