# @ragsystem/backend-plugin-media-generation

媒体生成插件：文生图 / 图生图（参考图）、文生视频 / 图生视频（首帧/首尾帧）。
接入 6 类厂商（智谱、火山方舟、阿里百炼、魔搭社区、OpenAI、Google），生成产物立即转存到会话工作区（厂商 URL 有效期仅 1h～24h），经现有 `file_ref` 渲染链路在聊天内展示（图片内联 + lightbox，视频播放器）。

## 提供的 Agent 工具

| 工具 | 说明 | 启用名 |
|---|---|---|
| 文生图/图生图 | 同步生成；参考图支持需模型能力（glm-image 纯文生图） | `generate_image` |
| 文生视频/图生视频 | 异步任务，阻塞等待至超时（默认 240s，可配 30-900s）；超时返回 `task_ref` | `generate_video` |
| 视频任务续查 | 单次查询；完成即落盘返回视频路径 | `check_video_task` |

工具在各 Agent 的 `enabled_tools` 中勾选启用（Agent Studio 工具选择面会列出）。

## 配置步骤

媒体 Provider 完全插件自管（厂商/凭证/模型均存插件配置段，不进 core Provider 体系）。

**插件设置**：设置 → 插件设置 → 媒体生成：

1. 「图像生成」组：启用 + 选厂商 + 填该厂商 API Key + 填生图模型名（如 `glm-image`、`doubao-seedream-5-0-pro`）
   - 厂商：智谱（`https://open.bigmodel.cn`）/ 火山方舟（`https://ark.cn-beijing.volces.com`）/ 阿里百炼（`https://dashscope.aliyuncs.com`）/ 魔搭社区（`https://api-inference.modelscope.cn`，仅生图，填访问令牌 Access Token，需绑定阿里云账号并实名认证，每日有免费额度）/ OpenAI（需海外网络）/ Google（需海外网络）
   - Endpoint 留空用厂商默认地址；代理/私有部署时填写
2. 「视频生成」组：同构（生视频模型如 `cogvideox-3`）+ 等待超时（30-900s）
3. 厂商上新模型直接填新模型名即可——目录未收录时能力按厂商默认能力处理（比例/分辨率档夹取）。

## 内置模型目录（价格随官方调整）

| 厂商 | 生图 | 生视频 |
|---|---|---|
| 智谱 | glm-image（约 0.1 元/张） | cogvideox-3（1 元/次，5/10s） |
| 火山方舟 | doubao-seedream-5-0-pro / 5-0-lite / 4-0 | doubao-seedance-2-0 / 2-0-mini |
| 阿里百炼 | wan2.7-image-pro / wan2.7-image | wan2.7-t2v / wan2.7-i2v / wan2.6-i2v-flash |
| 魔搭社区 | Qwen/Qwen-Image / Tongyi-MAI/Z-Image-Turbo（免费额度） | 官方未开放视频 API |
| OpenAI | gpt-image-1 / gpt-image-1-mini | sora-2 / sora-2-pro |
| Google | gemini-3.1-flash-image / gemini-3-pro-image | veo-3.1(-fast)-generate-preview |

## 行为要点

- **产物转存**：生成完成立即下载到工作区 `media/images/`、`media/videos/`（含封面），聊天内以 `<file_ref path="..." presentation="inline"/>` 内联展示；模型已被告知该标记语法。
- **参数夹取**：比例/分辨率/时长超出所选模型能力时自动夹到最近合法档并在结果中说明。
- **魔搭生图**：厂商侧为异步任务，adapter 内同步提交并轮询（整体上限 10 分钟，3s 间隔）；超出模型单边分辨率上限（Qwen-Image 1664 / FLUX 1024 / 其余 2048）时等比缩入。
- **取消**：run 取消（AbortSignal）即停止轮询；远端任务不取消（成功才计费），可稍后 `check_video_task` 续查。
- **进度事件**（ephemeral，前端按 `plugin_id + event` 消费）：`media.image_started/completed/failed`、`media.video_started/progress/completed/failed`。
- **插件自管配置**：厂商/凭证/模型全部存插件配置段（system config 扩展），不向 core Provider 体系注册任何类型。

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
