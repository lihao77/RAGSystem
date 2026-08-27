# @ragsystem/backend-plugin-media-generation

媒体生成插件：文生图 / 图生图（参考图）、文生视频 / 图生视频（首帧/首尾帧）。
接入 5 类厂商（智谱、火山方舟、阿里百炼、OpenAI、Google），生成产物立即转存到会话工作区（厂商 URL 有效期仅 1h～24h），经现有 `file_ref` 渲染链路在聊天内展示（图片内联 + lightbox，视频播放器）。

## 提供的 Agent 工具

| 工具 | 说明 | 启用名 |
|---|---|---|
| 文生图/图生图 | 同步生成；参考图支持需模型能力（glm-image 纯文生图） | `generate_image` |
| 文生视频/图生视频 | 异步任务，阻塞等待至超时（默认 240s，可配 30-900s）；超时返回 `task_ref` | `generate_video` |
| 视频任务续查 | 单次查询；完成即落盘返回视频路径 | `check_video_task` |

工具在各 Agent 的 `enabled_tools` 中勾选启用（Agent Studio 工具选择面会列出）。

## 配置步骤

插件按厂商注册 provider type（类型即厂商，自带默认 Endpoint 与 API 协议路由），每个类型声明自己的模型映射任务：`image`（生图模型）/ `video`（生视频模型）。

1. **创建媒体 Provider 条目**：模型 Provider 管理页 → 添加 → 类型选"xx · 媒体生成（插件）"：
   - 智谱（`https://open.bigmodel.cn`）/ 火山方舟（`https://ark.cn-beijing.volces.com`）/ 阿里百炼（`https://dashscope.aliyuncs.com`）/ OpenAI（需海外网络）/ Google（需海外网络）
   - 填 API Key（Endpoint 留空用厂商默认地址）
   - **模型映射**：任务下拉为"生图模型 / 生视频模型"，把该厂商的生成模型填在对应任务下（如生图模型 `glm-image`、生视频模型 `cogvideox-3`）——一个条目可同时配两类模型
2. **插件设置**：设置 → 插件设置 → 媒体生成：
   - 「图像生成」组：启用 + 选 Provider + 选该条目上的生图模型（下拉联动）
   - 「视频生成」组：同构（可复用同一 Provider，选其生视频模型）+ 等待超时
3. 厂商上新模型未收录时用「自定义模型名」兜底（能力按厂商默认能力处理）。

## 内置模型目录（价格随官方调整）

| 厂商 | 生图 | 生视频 |
|---|---|---|
| 智谱 | glm-image（约 0.1 元/张） | cogvideox-3（1 元/次，5/10s） |
| 火山方舟 | doubao-seedream-5-0-pro / 5-0-lite / 4-0 | doubao-seedance-2-0 / 2-0-mini |
| 阿里百炼 | wan2.7-image-pro / wan2.7-image | wan2.7-t2v / wan2.7-i2v / wan2.6-i2v-flash |
| OpenAI | gpt-image-1 / gpt-image-1-mini | sora-2 / sora-2-pro |
| Google | gemini-3.1-flash-image / gemini-3-pro-image | veo-3.1(-fast)-generate-preview |

## 行为要点

- **产物转存**：生成完成立即下载到工作区 `media/images/`、`media/videos/`（含封面），聊天内以 `<file_ref path="..." presentation="inline"/>` 内联展示；模型已被告知该标记语法。
- **参数夹取**：比例/分辨率/时长超出所选模型能力时自动夹到最近合法档并在结果中说明。
- **取消**：run 取消（AbortSignal）即停止轮询；远端任务不取消（成功才计费），可稍后 `check_video_task` 续查。
- **进度事件**（ephemeral，前端按 `plugin_id + event` 消费）：`media.image_started/completed/failed`、`media.video_started/progress/completed/failed`。
- **依赖核心扩展**：`context.providerTypes.register()` 注册面（backend-core 提供插件 Provider 类型基础设施）。

## 开发

```bash
npm install && npm run build && npm test
```

本地联调：repo 根目录 `npm run plugin -- add plugins/backend-plugin-media-generation`。

## 分发

```bash
npm run bundle-plugin -- plugins/backend-plugin-media-generation
```

## 约定

详见 `docs/BACKEND_PLUGIN_CONFIG.md`；无前端 UI bundle（聊天内展示复用宿主 file_ref 渲染）。
