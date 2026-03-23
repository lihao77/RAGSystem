# Source Pages

## Built-in Sources

### `portal`
- URL: `http://swzx.gxzf.gov.cn/swfw/sqfw/sssq/`
- 角色：入口页
- 输出重点：导航链接、iframe、二级实时水情页入口

### `river`
- URL: `http://124.227.12.36:8259/sssq/hdsq/ShowRiverData.aspx`
- 角色：江河实时水情
- 预期字段：站名、河流名、水位、警戒水位、时间、趋势

### `reservoir`
- URL: `http://124.227.12.36:8259/sssq/hdsq/ShowRsvrData.aspx`
- 角色：水库实时水情
- 预期字段：水库名称、库水位、汛限或警戒水位、入库流量、出库流量、时间

## Parsing Strategy

1. 优先解析 HTML `<table>`。
2. 如果没有可识别表格，回退到页面里的 `links` 和 `iframe_links`。
3. 根据表头关键词归一化字段。
4. 警戒水位缺失时，回填 `guangxi-geodata/data/hydrological_stations.json` 中的静态站点值。

## Debugging

离线调试建议：
1. 保存真实网页 HTML。
2. 用 `--html-file` 复现解析。
3. 如字段未对齐，优先新增表头别名，而不是写死列号。
