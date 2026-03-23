# Weather Source

## Data Source

- 服务：`wttr.in`
- 方式：HTTP JSON 请求
- 优点：无需 API Key，适合轻量实时降雨补数
- 风险：属于公共服务，可能偶发限流或不可达

## Output Semantics

- `rainfall_24h_mm`: 当日逐小时降雨量求和
- `forecast_rainfall_mm`: 次日逐小时降雨量求和
- `precip_now_mm`: 当前小时降雨量

## Fallback

若天气请求失败，脚本不会抛异常退出，而是返回：
- `degraded: true`
- `rainfall_24h_mm: null`
- `degraded_note`

这样 Agent 可以继续后续流程，并决定是否改为请求用户补充数据。
