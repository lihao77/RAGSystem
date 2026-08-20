// 桌宠动画链纯逻辑：动画目录、概率状态机与移动规划。
// 移植自 dsh-pet（MIT, https://github.com/PC2005-cloud/dsh-pet）lib/client.js，
// 去掉 React/DSH 外壳依赖，仅保留与 DOM 无关的决策逻辑，便于单测与复用。

/** thumb 视频 640×360 画布，人物“脚底”在 y=330（8.33% 底边距，缩放后落地对齐用）。 */
export const CANVAS_H = 360;
export const FEET_Y = 330;

/** 点击/拖拽命中矩形（thumb 640×360 像素坐标，多数动画人物站立帧的对称范围）。 */
export const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };

/** 主体待机动画（链中作为“缓冲”反复回到）。 */
export const IDLE = '待机呼吸休闲';
/** 转向动画（内容为“从偏左看到偏右”，播完翻转朝向）。 */
export const TURN = '东张西望';
/** 随机动作池（等概率抽取，去重上一个）。 */
export const ACTS = [
  '悠闲哼歌',
  '超大伸懒腰',
  '原地专心玩魔方',
  '原地敲击桌面互动',
  '原地重力下蹲压缩',
  '哈欠连天',
  '原地小憩沉眠',
  '原地蹲下玩玩具汽车',
  '鲸鱼吐泡泡特效',
  '女仆屈膝礼仪',
  '被吓一跳（炸毛）',
  '原地跳跃抓碎头顶物品',
  '小幅度原地 360 度旋转展示',
  '偷吃零食被抓住',
  '玩游戏气急败坏',
  '用鲸鱼尾巴拍打地面',
  '打瞌睡被惊醒',
  '玩水枪',
  '小提琴演奏',
  '蓝鲸现世',
  '吃白饭',
  '照镜子',
  '优雅女仆舞',
  '轻快摇摆舞',
  '可爱宅舞',
  '整体换装试色',
  '大口吃零食',
  '吹气球',
  '动物环绕',
  '深度思考碎碎念',
  '轻快记录',
  '写代码',
  '吃Token',
  '吃早餐',
  '吃午餐',
  '吃晚餐',
  '放风筝',
  '摇扇纳凉',
  '吃冰淇淋融化',
  '被落叶淹没',
  '中秋赏月吃月饼',
  '堆雪人',
];
/** 点击回应动画池（3 选 1）。 */
export const CLICKS = ['点击回应 - 开心跃动', '点击回应 - 害羞惊讶', '点击回应 - 傲娇生气（侧身展示）'];
/** 拖拽动画（按住跟手时播放）。 */
export const DRAG = '被鼠标拖拽悬空反馈';
/** 移动动画池：动画提供“走路姿态”，位置移动由 rAF 按视频时钟驱动。 */
export const MOVES = ['螃蟹走路', '原地漂浮踏步', '原地左转奔跑'];

/** agent 状态联动池：busy（有 run 进行中）循环播放的工作动画。 */
export const BUSY_ACTS = ['写代码', '深度思考碎碎念', '轻快记录', '原地敲击桌面互动', '吃Token'];
/** 一次性脉冲动画：run 失败炸毛 / run 完成庆祝。 */
export const ERROR_ACT = '被吓一跳（炸毛）';
export const DONE_ACTS = ['点击回应 - 开心跃动', '哈欠连天'];

/** 每次移动的最短/最长距离（px）与屏幕边缘安全边距。 */
export const MOVE_MIN_PX = 60;
export const MOVE_MAX_PX = 240;
export const MOVE_MARGIN = 20;
/** 移动动画开头/结尾的“准备/收尾”时长（s），期间位置不动。 */
export const MOVE_LEAD_SEC = 2;
export const MOVE_TAIL_SEC = 2;

/** 点击与拖拽的判定阈值（px）。 */
export const DRAG_THRESHOLD = 5;

/** 链式概率边界：30% 待机 / 10% 转向 / 40% 动作 / 20% 移动。 */
export const CHAIN_PROBS = { idle: 0.3, turn: 0.4, act: 0.8 };

/**
 * 生成 [min, max) 区间随机整数。
 * @param {(n?: number) => number} [rand] 可注入的随机源（默认 Math.random）
 */
export function randomBetween(min, max, rand = Math.random) {
  return Math.floor(min + rand() * (max - min));
}

/** 从池中等概率抽取一个，exclude 排除指定名字（避免连续重复）。 */
export function pick(pool, { exclude = null, rand = Math.random } = {}) {
  const entries = exclude ? pool.filter((name) => name !== exclude) : pool;
  return entries[Math.floor(rand() * entries.length)];
}

/**
 * 加权抽取：各项权重 = weights[name]（默认 1），按累计权重区间落点。
 * rand()=0 时取首个低权项，趋近 1 时取高权项——测试可用极端 rand 值断言。
 */
export function pickWeighted(pool, { weights = {}, exclude = null, rand = Math.random } = {}) {
  const entries = exclude ? pool.filter((name) => name !== exclude) : pool;
  if (entries.length === 0) return undefined;
  let total = 0;
  const cumulative = entries.map((name) => {
    total += Math.max(0, weights[name] ?? 1);
    return total;
  });
  const roll = rand() * total;
  for (let index = 0; index < entries.length; index += 1) {
    if (roll < cumulative[index]) return entries[index];
  }
  return entries[entries.length - 1];
}

/**
 * 季节/夜间动画权重（额外加成，基准 1）：按月份激活应景动画、
 * 深夜提升小憩/哈欠——让"堆雪人/中秋赏月/摇扇纳凉"等素材在合适时间自然出现。
 */
export function seasonalWeights(now = new Date()) {
  const month = now.getMonth() + 1;
  const hour = now.getHours();
  const weights = {};
  const boost = (name, extra) => {
    weights[name] = (weights[name] ?? 0) + extra;
  };
  if (month === 12 || month <= 2) {
    boost('堆雪人', 3);
  } else if (month <= 5) {
    boost('放风筝', 2);
  } else if (month <= 8) {
    boost('摇扇纳凉', 3);
    boost('吃冰淇淋融化', 2);
  } else {
    boost('被落叶淹没', 2);
    if (month === 9) boost('中秋赏月吃月饼', 3);
  }
  if (hour >= 22 || hour < 6) {
    boost('原地小憩沉眠', 2);
    boost('哈欠连天', 1);
  }
  return weights;
}

/**
 * 按后端 manifest 返回的可用动画名过滤各池（null = 假定全套齐全）。
 * 待机动画缺失时返回 null（素材不完整则整体隐藏，不播残缺链）。
 */
export function buildCatalog(available) {
  const has = new Set(available ?? [IDLE, TURN, ...ACTS, ...CLICKS, DRAG, ...MOVES, ...BUSY_ACTS, ERROR_ACT, ...DONE_ACTS]);
  if (!has.has(IDLE)) return null;
  return {
    idle: IDLE,
    turn: has.has(TURN) ? TURN : null,
    acts: ACTS.filter((name) => has.has(name)),
    clicks: CLICKS.filter((name) => has.has(name)),
    drag: has.has(DRAG) ? DRAG : null,
    moves: MOVES.filter((name) => has.has(name)),
    busy: BUSY_ACTS.filter((name) => has.has(name)),
    error: has.has(ERROR_ACT) ? ERROR_ACT : null,
    done: DONE_ACTS.filter((name) => has.has(name)),
  };
}

/**
 * 链式状态机：当前一次性动画播完后的下一个动作。
 * @param {object} input
 * @param {'idle'|'busy'} [input.mood] busy（agent 运行中）时优先工作动画、不漫游；
 *   idle 走 30/10/40/20 概率链。
 * @returns {{ kind: 'idle'|'turn'|'act', anim: string } | { kind: 'move', plan: object } | { kind: 'act', anim: string, fallback: true }}
 */
export function pickNext({ current, catalog, mood = 'idle', facing = 'left', centerX, centerY, viewportWidth, viewportHeight, halfW, halfH, rand = Math.random }) {
  const roll = rand();
  if (mood === 'busy') {
    // busy：70% 工作动画 / 30% 待机呼吸；不转向、不漫游、不随机动作池
    if (catalog.busy.length > 0 && roll < 0.7) return { kind: 'act', anim: pick(catalog.busy, { exclude: current, rand }) };
    return { kind: 'idle', anim: catalog.idle };
  }
  if (roll < CHAIN_PROBS.idle) return { kind: 'idle', anim: catalog.idle };
  if (roll < CHAIN_PROBS.turn && catalog.turn) return { kind: 'turn', anim: catalog.turn };
  if (roll < CHAIN_PROBS.act || catalog.moves.length === 0) {
    return { kind: 'act', anim: pickWeighted(catalog.acts, { exclude: current, weights: seasonalWeights(), rand }) };
  }
  const plan = planMove({ current, facing, centerX, centerY, viewportWidth, viewportHeight, halfW, halfH, rand });
  return plan ? { kind: 'move', plan, anim: pick(catalog.moves, { rand }) } : { kind: 'act', anim: pick(catalog.acts, { exclude: current, rand }), fallback: true };
}

/**
 * 规划一次屏幕漫游（朝当前朝向）。返回比例制计划（resize 后仍正确），
 * 空间不够时返回 null。
 * @param {{ current: string, facing: 'left'|'right', centerX: number, centerY: number, viewportWidth: number, viewportHeight: number, halfW: number, halfH: number, rand?: Function }} input
 */
export function planMove({ current, facing, centerX, centerY, viewportWidth, viewportHeight, halfW, halfH, rand = Math.random }) {
  // 方向按“实际朝向”计算：刚播完转向动画（current===TURN）时 facing 即将翻转，方向取反
  const dir = (facing === 'right') !== (current === TURN) ? 1 : -1;
  const distance = randomBetween(MOVE_MIN_PX, MOVE_MAX_PX, rand);
  const target = centerX + dir * distance;
  const leftBound = MOVE_MARGIN + halfW;
  const rightBound = viewportWidth - MOVE_MARGIN - halfW;
  if (target < leftBound || target > rightBound) return null;
  const topBound = MOVE_MARGIN + halfH;
  const bottomBound = viewportHeight - MOVE_MARGIN - halfH;
  const y = Math.min(Math.max(centerY, topBound), bottomBound);
  return {
    dir,
    startRatio: centerX / viewportWidth,
    startYRatio: y / viewportHeight,
    targetRatio: target / viewportWidth,
    totalRatio: Math.abs(target - centerX) / viewportWidth,
  };
}

/**
 * 移动进度插值：按动画播放时钟返回当前水平比例位置。
 * 开头 LEAD 秒原地、结尾 TAIL 秒已到位、中间窗口线性插值（比例制，无滑步感）。
 */
export function moveProgressRatio({ plan, currentTime, duration }) {
  const travelWindow = Math.max(0.1, duration - MOVE_LEAD_SEC - MOVE_TAIL_SEC);
  if (currentTime <= MOVE_LEAD_SEC) return plan.startRatio;
  if (currentTime >= duration - MOVE_TAIL_SEC) return plan.targetRatio;
  const progress = (currentTime - MOVE_LEAD_SEC) / travelWindow;
  return plan.startRatio + plan.dir * plan.totalRatio * progress;
}

/** thumb 画布（640×360）下的“脚底”下沉量（px），用于把脚贴到视口底线。 */
export function feetBottomPad(stageHeight) {
  return (stageHeight * (CANVAS_H - FEET_Y)) / CANVAS_H;
}
