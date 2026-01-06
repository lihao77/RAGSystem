# 打字机效果实现

**日期**: 2026-01-06
**功能**: 为所有文本内容添加逐字显示的打字机效果

---

## 实现概述

通过 `typewriter()` 函数，为以下内容添加打字机效果：
1. ✅ **MasterAgent 任务分析** - 速度：10ms/字符
2. ✅ **ReActAgent 思考步骤** - 速度：15ms/字符
3. ✅ **最终答案** - 速度：15ms/字符
4. ❌ **工具调用详情** - 立即显示（无打字机效果）

---

## 核心函数

### 1. `typewriter(target, key, text, speed, timerId, showCursor)`

**功能**: 逐字更新对象的某个字段

**参数**:
- `target`: 目标对象（如 `currentMsg`）
- `key`: 要更新的字段名（如 `'content'`, `'thinking'`）
- `text`: 要显示的文本内容
- `speed`: 打字速度（毫秒/字符）
  - `0`: 立即显示
  - `10`: 快速（任务分析）
  - `15`: 中速（思考步骤、最终答案）
  - `30`: 慢速（默认值）
- `timerId`: 定时器唯一标识，用于管理和清除
- `showCursor`: 是否显示闪烁光标（暂未实现）

**工作原理**:
```javascript
let currentIndex = 0;
const type = () => {
  if (currentIndex < text.length) {
    target[key] = originalText + text.substring(0, currentIndex + 1);
    currentIndex++;
    setTimeout(type, speed);  // 递归调用
    scrollToBottom();
  }
};
type();
```

**示例**:
```javascript
// 为 currentMsg.content 添加打字机效果
typewriter(
  currentMsg,           // 目标对象
  'content',            // 字段名
  '这是一段答案',       // 文本内容
  15,                   // 15ms/字符
  'msg-0-content'       // 定时器ID
);

// 结果: "这" → "这是" → "这是一" → ... → "这是一段答案"
```

---

### 2. `typewriterPush(array, item, textKey, speed, timerId)`

**功能**: 为数组添加新元素，并对指定字段应用打字机效果

**用途**: 用于 `thinking_steps` 数组，每个步骤的 `thought` 字段逐字显示

**参数**:
- `array`: 目标数组（如 `currentMsg.thinking_steps`）
- `item`: 要添加的对象
- `textKey`: 对象中需要打字机效果的字段名（默认 `'thought'`）
- `speed`: 打字速度
- `timerId`: 定时器ID

**工作原理**:
```javascript
// 1. 创建空白对象（thought 为空字符串）
const tempItem = { ...item, thought: '' };
array.push(tempItem);

// 2. 获取数组中的引用
const targetItem = array[array.length - 1];

// 3. 逐字填充 thought 字段
typewriter(targetItem, 'thought', item.thought, speed, timerId);
```

**示例**:
```javascript
typewriterPush(
  currentMsg.thinking_steps,  // 目标数组
  {
    thought: '用户想查询桂林2020年的洪涝灾害',
    round: 1,
    has_actions: true,
    has_answer: false
  },
  'thought',                   // 要打字的字段
  15,                          // 15ms/字符
  'msg-0-step-0'               // 定时器ID
);
```

---

## 定时器管理

### 为什么需要定时器ID？

多个打字机效果可能同时运行：
- MasterAgent 任务分析正在打字
- ReActAgent 思考步骤正在打字
- 最终答案正在打字

如果不管理定时器，会导致：
- ❌ 内存泄漏（定时器无法清除）
- ❌ 新对话覆盖旧对话时，旧的打字仍在继续

### 定时器存储

```javascript
const typewriterTimers = ref(new Map());

// 存储定时器
typewriterTimers.value.set('msg-0-content', timerId);

// 清除定时器
const timerId = typewriterTimers.value.get('msg-0-content');
clearTimeout(timerId);
typewriterTimers.value.delete('msg-0-content');

// 清除所有定时器（开始新对话时）
typewriterTimers.value.forEach(timer => clearTimeout(timer));
typewriterTimers.value.clear();
```

### 定时器命名规则

```javascript
// 最终答案
`msg-${assistantMsgIndex}-content`

// MasterAgent 任务分析
`msg-${assistantMsgIndex}-thinking`

// ReActAgent 思考步骤
`msg-${assistantMsgIndex}-step-${stepIndex}`
```

---

## SSE 事件处理

### 事件类型与打字速度

| 事件类型 | 内容 | 打字速度 | 说明 |
|---------|------|---------|------|
| `thought` | MasterAgent 任务分析 | 10ms/字符 | 最快，快速显示分析结果 |
| `thought_structured` | ReActAgent 思考步骤 | 15ms/字符 | 中速，便于阅读 |
| `chunk` | 最终答案 | 15ms/字符 | 中速，模拟真实打字 |
| `tool_start` | 工具开始 | 立即显示 | 无需打字机效果 |
| `tool_end` | 工具结束 | 立即显示 | 无需打字机效果 |

### 代码示例

```javascript
if (data.type === 'chunk') {
  // 最终答案 - 15ms/字符
  typewriter(
    currentMsg,
    'content',
    data.content,
    15,
    `msg-${assistantMsgIndex}-content`
  );
} else if (data.type === 'thought') {
  // MasterAgent 任务分析 - 10ms/字符
  typewriter(
    currentMsg,
    'thinking',
    data.content + '\n',
    10,
    `msg-${assistantMsgIndex}-thinking`
  );
} else if (data.type === 'thought_structured') {
  // ReActAgent 思考步骤 - 15ms/字符
  const timerId = `msg-${assistantMsgIndex}-step-${currentMsg.thinking_steps.length}`;
  typewriterPush(
    currentMsg.thinking_steps,
    {
      thought: data.thought,
      round: data.round,
      has_actions: data.has_actions,
      has_answer: data.has_answer
    },
    'thought',
    15,
    timerId
  );
}
```

---

## 光标动画（CSS）

### 闪烁光标

```css
@keyframes blink {
  0%, 50% {
    opacity: 1;
  }
  51%, 100% {
    opacity: 0;
  }
}

.typing-cursor::after {
  content: '▋';
  animation: blink 1s infinite;
  margin-left: 2px;
  color: #667eea;
}
```

**注意**: 当前实现中，光标效果暂未集成（需要动态添加/移除 `.typing-cursor` 类）

---

## 用户体验优势

### 1. **视觉反馈**
- 用户看到文字逐渐出现，感知系统正在"思考"和"生成"
- 比一次性显示更自然，符合人类阅读习惯

### 2. **降低认知负荷**
- 大段文本分批出现，不会瞬间压倒用户
- 用户有时间逐步理解内容

### 3. **增加沉浸感**
- 模拟真实对话场景
- 提升 AI 交互的拟人化体验

### 4. **平滑过渡**
- 不同阶段（任务分析 → 工具调用 → 思考 → 答案）平滑过渡
- 避免界面突然跳动

---

## 性能考虑

### 1. **定时器数量**
- 每个文本字段一个定时器
- 通过 `timerId` 精确管理，避免泄漏

### 2. **速度优化**
- 任务分析：10ms/字符（较快，因为内容简短）
- 思考步骤：15ms/字符（中速，平衡可读性和速度）
- 最终答案：15ms/字符（保持一致体验）

### 3. **立即显示模式**
- 工具调用结果无需打字机效果（数据量大，打字太慢）
- 通过 `speed = 0` 实现立即显示

### 4. **自动滚动**
- 每次更新文本后调用 `scrollToBottom()`
- 确保用户始终看到最新内容

---

## 可配置性

### 全局速度调整

如果用户觉得打字速度过快/过慢，可以调整速度参数：

```javascript
// 当前速度
const SPEED_THINKING = 10;    // 任务分析
const SPEED_STEP = 15;        // 思考步骤
const SPEED_CONTENT = 15;     // 最终答案

// 更快（5ms/字符）
const SPEED_THINKING = 5;
const SPEED_STEP = 8;
const SPEED_CONTENT = 8;

// 更慢（30ms/字符）
const SPEED_THINKING = 20;
const SPEED_STEP = 30;
const SPEED_CONTENT = 30;
```

### 禁用打字机效果

```javascript
// 将所有速度设为 0，立即显示
typewriter(currentMsg, 'content', data.content, 0, null);
```

---

## 待优化功能

### 1. **光标动态显示**
- 打字过程中显示闪烁光标
- 完成后移除光标

实现思路：
```javascript
// 打字中
target[key] = displayText;
target._isTyping = true;  // 添加标志

// 打字完成
target._isTyping = false;
```

HTML:
```vue
<div :class="{ 'typing-cursor': msg._isTyping }">
  {{ msg.content }}
</div>
```

### 2. **可跳过动画**
- 用户点击消息区域，立即显示全部文本
- 实现：清除定时器，直接设置完整文本

### 3. **速度设置界面**
- 在侧边栏添加"打字速度"选项
- 保存用户偏好到 localStorage

### 4. **代码块特殊处理**
- 检测 Markdown 代码块
- 代码块内容逐行显示而非逐字（更自然）

---

## 测试方法

1. 启动前端：`npm run dev`
2. 提问：**"查询桂林2020年的洪涝灾害情况"**
3. 观察效果：
   - ✅ 任务分析逐字出现（蓝色卡片）
   - ✅ 思考步骤逐字出现（紫色卡片）
   - ✅ 最终答案逐字出现（白色区域）
   - ✅ 工具调用立即显示（无打字效果）

---

**状态**: ✅ 已实现
**体验**: 🌟 大幅提升交互流畅度和沉浸感
