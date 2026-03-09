# 天气预报查询最佳实践技能指南

## 1. 地理位置查询优化

### 1.1 搜索策略
- **首选英文名称**：使用城市的标准英文名称（如"Nanning"而非"南宁"）
- **简化查询**：只输入城市名，避免过多修饰词（如"Nanning"而非"Nanning, Guangxi, China"）
- **增加结果数量**：设置`limit=5`以获取更多匹配项，便于人工筛选

### 1.2 坐标验证
- 确认返回结果的`Country Code`为"CN"（中国）
- 检查`Type`字段是否为"Administrative capital"（行政中心）
- 核对`Population`数据确认城市规模

## 2. 天气预报参数配置

### 2.1 基础参数
```json
{
  "latitude": 22.8167,
  "longitude": 108.3167,
  "days": 7,
  "granularity": "daily",
  "include_precipitation_probability": true
}
```

### 2.2 高级参数
- `include_normals: true` - 包含气候常态数据（30年平均）
- `source: "openmeteo"` - 指定国际数据源（适用于中国地区）
- `granularity: "hourly"` - 需要小时级预报时使用

## 3. 错误处理与重试策略

### 3.1 常见错误及解决方案
1. **"No locations found"**
   - 尝试不同拼写方式
   - 使用更简单的查询词
   - 增加`limit`值

2. **API连接失败**
   - 检查服务状态：`check_service_status()`
   - 指定数据源：`source: "openmeteo"`
   - 等待后重试

### 3.2 服务状态检查
```python
# 在重要查询前检查服务状态
status = check_service_status()
if status["overall_status"] == "✅ All Services Operational":
    # 执行查询
    forecast = get_forecast(...)
else:
    # 记录错误并采取备用方案
    log_error("Weather API unavailable")
```

## 4. 数据解析与展示

### 4.1 温度单位转换
- API返回华氏度(°F)，需转换为摄氏度(°C)
- 转换公式：`°C = (°F - 32) × 5/9`

### 4.2 风速单位转换
- API返回英里/小时(mph)，需转换为公里/小时(km/h)
- 转换公式：`km/h = mph × 1.60934`

### 4.3 降水量单位转换
- API返回英寸(in)，需转换为毫米(mm)
- 转换公式：`mm = in × 25.4`

## 5. 缓存优化

### 5.1 缓存策略
- 相同坐标的查询结果可缓存1-6小时
- 使用`cache_key = f"{lat}_{lon}_{days}_{granularity}"`
- 设置合理的缓存过期时间

### 5.2 性能监控
- 监控缓存命中率
- 记录API响应时间
- 设置请求频率限制

## 6. 用户体验优化

### 6.1 天气预报摘要
- 提供3-5天的关键信息摘要
- 突出降水概率和极端天气
- 包含穿衣和出行建议

### 6.2 可视化展示
- 生成温度趋势图
- 显示降水概率条形图
- 制作风速风向玫瑰图

## 7. 代码示例

```python
def get_weather_forecast(city_name, days=7):
    """
    获取城市天气预报的最佳实践实现
    """
    # 1. 搜索位置
    locations = search_location(city_name, limit=5)
    
    # 2. 筛选中国城市
    china_locations = [loc for loc in locations 
                      if loc.get("country_code") == "CN"]
    
    if not china_locations:
        raise ValueError(f"未找到中国城市: {city_name}")
    
    # 3. 选择最佳匹配（优先行政中心）
    best_location = None
    for loc in china_locations:
        if loc.get("type") == "Administrative capital":
            best_location = loc
            break
    
    if not best_location:
        best_location = china_locations[0]
    
    # 4. 获取坐标
    lat = best_location["coordinates"]["latitude"]
    lon = best_location["coordinates"]["longitude"]
    
    # 5. 检查服务状态
    status = check_service_status()
    if "operational" not in status["overall_status"].lower():
        logger.warning("Weather API may have issues")
    
    # 6. 获取天气预报
    forecast = get_forecast(
        latitude=lat,
        longitude=lon,
        days=days,
        granularity="daily",
        include_precipitation_probability=True,
        include_normals=True,
        source="openmeteo"  # 中国地区使用Open-Meteo
    )
    
    # 7. 数据转换和格式化
    formatted_forecast = format_forecast_data(forecast)
    
    return formatted_forecast

def format_forecast_data(forecast):
    """格式化天气预报数据"""
    formatted = {
        "location": forecast.get("location", ""),
        "forecast_days": [],
        "summary": {
            "max_temp": 0,
            "min_temp": 100,
            "rainy_days": 0
        }
    }
    
    for day in forecast.get("daily_forecasts", []):
        # 温度转换
        temp_high_c = (day["temperature_high"] - 32) * 5/9
        temp_low_c = (day["temperature_low"] - 32) * 5/9
        
        formatted_day = {
            "date": day["date"],
            "temperature": {
                "high": round(temp_high_c, 1),
                "low": round(temp_low_c, 1)
            },
            "conditions": day["conditions"],
            "precipitation_probability": day["precipitation_probability"],
            "precipitation_mm": round(day["precipitation"] * 25.4, 1),
            "wind_kmh": round(day["wind_speed"] * 1.60934, 1),
            "uv_index": day["uv_index"]
        }
        
        formatted["forecast_days"].append(formatted_day)
        
        # 更新摘要
        formatted["summary"]["max_temp"] = max(
            formatted["summary"]["max_temp"], temp_high_c
        )
        formatted["summary"]["min_temp"] = min(
            formatted["summary"]["min_temp"], temp_low_c
        )
        if day["precipitation_probability"] > 30:
            formatted["summary"]["rainy_days"] += 1
    
    return formatted
```

## 8. 监控与日志

### 8.1 关键指标
- API成功率
- 平均响应时间
- 缓存命中率
- 用户查询频率

### 8.2 错误日志
- 记录所有API错误
- 跟踪重试次数
- 监控服务状态变化

## 9. 安全与限制

### 9.1 请求限制
- 遵守API调用频率限制
- 实现请求队列和限流
- 设置合理的超时时间

### 9.2 数据安全
- 不存储用户精确位置
- 匿名化查询日志
- 定期清理缓存数据

---

**最后更新：** 2026年3月9日
**基于：** 南宁天气预报查询实践经验
**适用场景：** 中国城市天气预报查询
**推荐配置：** Open-Meteo数据源 + 7天预报 + 每日粒度