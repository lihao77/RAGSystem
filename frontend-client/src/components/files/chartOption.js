/**
 * ECharts option 的主题色合并与构建（供 ChartRenderer 使用）。
 *
 * 坐标轴配置可能是单对象，也可能是数组（双 Y 轴等多轴图）。合并主题色时必须保持原形态：
 * 对数组做对象展开会把下标 "0"/"1" 和 length 变成轴属性，ECharts 只解析出一个畸形单轴，
 * series 的 yAxisIndex 找不到轴模型会直接抛 `yAxis "N" not found`，打断 Vue 渲染队列导致页面卡死。
 */

const mergeSingleAxis = (userAxis, baseColors) => {
  // 数组元素也是数组属病态输入，透传给 ECharts 自行报缺失，避免展开成下标对象重演 yAxis not found
  if (!userAxis || typeof userAxis !== 'object' || Array.isArray(userAxis)) return userAxis;

  return {
    ...userAxis,
    axisLine: {
      ...(userAxis.axisLine || {}),
      lineStyle: {
        color: baseColors.axisLine,
        ...(userAxis.axisLine?.lineStyle || {})
      }
    },
    axisLabel: {
      color: baseColors.axisLabel,
      ...(userAxis.axisLabel || {})
    },
    splitLine: {
      ...(userAxis.splitLine || {}),
      lineStyle: {
        color: baseColors.splitLine,
        ...(userAxis.splitLine?.lineStyle || {})
      }
    }
  };
};

/** 单对象/数组两种形态都保留，逐轴注入主题配色。 */
export const mergeAxisConfig = (userAxis, baseColors) => {
  if (!userAxis) return undefined;
  return Array.isArray(userAxis)
    ? userAxis.map((axis) => mergeSingleAxis(axis, baseColors))
    : mergeSingleAxis(userAxis, baseColors);
};

/**
 * tokens 为 CSS 变量解析出的具体色值（ECharts 不接受 CSS var），
 * 由调用方按当前主题计算，主题切换时重新调用即可。
 */
export function buildChartOption(userConfig, tokens) {
  const baseOption = {
    backgroundColor: 'transparent',
    textStyle: {
      color: tokens.textSecondary
    },
    title: {
      textStyle: {
        color: tokens.textPrimary
      }
    },
    legend: {
      textStyle: {
        color: tokens.textPrimary
      }
    },
    tooltip: {
      backgroundColor: tokens.bgElevated,
      borderColor: tokens.border,
      textStyle: {
        color: tokens.textPrimary
      }
    }
  };

  const axisColors = {
    axisLine: tokens.textMuted,
    axisLabel: tokens.textSecondary,
    splitLine: tokens.border
  };

  return {
    ...baseOption,
    ...userConfig,
    backgroundColor: userConfig.backgroundColor || 'transparent',
    xAxis: mergeAxisConfig(userConfig.xAxis, axisColors),
    yAxis: mergeAxisConfig(userConfig.yAxis, axisColors)
  };
}
