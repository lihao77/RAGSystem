// 桌宠动画链纯逻辑：动画目录、概率状态机与移动规划。
// 移植自 dsh-pet（MIT, https://github.com/PC2005-cloud/dsh-pet）src/client，
// 去掉 React/DSH 外壳依赖，仅保留与 DOM 无关的决策逻辑，便于单测与复用。
// 同步自 dsh-pet 0.2.0：分类加权动作池 + noMirror 文字类过滤 + 分动作移动参数。

/** thumb 视频 640×360 画布，人物“脚底”在 y=330（8.33% 底边距，缩放后落地对齐用）。 */
export const CANVAS_H = 360;
export const FEET_Y = 330;

/** 点击/拖拽命中矩形（thumb 640×360 像素坐标，多数动画人物站立帧的对称范围）。 */
export const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };

/** 主体待机动画（链中作为“缓冲”反复回到）。 */
export const IDLE = '待机呼吸休闲';
/** 转向动画（内容为“从偏左看到偏右”，播完翻转朝向）。 */
export const TURN = '东张西望';
/** 拖拽动画（按住跟手时播放）。 */
export const DRAG = '被鼠标拖拽悬空反馈';
/** 移动动画池：动画提供“走路姿态”，位置移动由 rAF 按视频时钟驱动。 */
export const MOVES = ['螃蟹走路', '原地漂浮踏步', '原地左转奔跑'];

/**
 * 随机动作分类池（同步自 dsh-pet config.jsonc）：先按 weight 选类、再在类内等权抽动作。
 * noMirror: true 表示“画面带文字、镜像会颠倒”——宠物面向右（被镜像）时整类不参与抽取。
 */
export const CATEGORIES = [
  {
    id: '小动作',
    weight: 20,
    actions: [
      '悠闲哼歌', '超大伸懒腰', '原地敲击桌面互动', '原地重力下蹲压缩', '哈欠连天',
      '原地小憩沉眠', '女仆屈膝礼仪', '被吓一跳', '小幅度原地360度旋转展示',
      '偷吃零食被抓住', '用鲸鱼尾巴拍打地面', '打瞌睡被惊醒', '照镜子', '整体换装试色',
      '轻快记录', '写代码', '摇扇纳凉', '晨间刷牙',
    ],
  },
  {
    id: '玩耍',
    weight: 20,
    actions: [
      '原地专心玩魔方', '原地蹲下玩玩具汽车', '鲸鱼吐泡泡特效', '原地跳跃抓碎头顶物品',
      '玩游戏气急败坏', '玩水枪', '小提琴演奏', '蓝鲸现世', '优雅女仆舞', '轻快摇摆舞',
      '可爱宅舞', '吹气球', '动物环绕', '放风筝', '拆礼物', '变鸽子', '扑克魔术',
      '抽陀螺', '吹笛子', '蝴蝶蜜蜂环绕头顶开花', '撸猫', '凭空生花', '骑木马',
      '三球抛接', '踢毽子', '下五子棋', '荡秋千',
    ],
  },
  {
    id: '吃什么',
    weight: 16,
    actions: [
      '吃白饭', '大口吃零食', '吃Token', '吃早餐', '吃午餐', '吃晚餐', '吃冰淇淋融化',
      '吃大闸蟹', '吃糖葫芦', '吃长寿面', '吃西瓜', '涮火锅',
    ],
  },
  {
    id: '时节',
    weight: 14,
    actions: [
      '被落叶淹没', '中秋赏月吃月饼', '堆雪人', '放烟花', '吃粽子', '吃年糕', '吃青团',
      '吃腊八粥', '吃重阳糕', '收红包', '写福字', '穿针乞巧', '舞狮头', '讨糖南瓜灯',
      '插茱萸赏菊', '放河灯', '萌化小幽灵', '装点圣诞树', '放孔明灯', '吃汤圆', '吃饺子',
    ],
  },
  {
    id: '文字',
    weight: 10,
    noMirror: true,
    actions: ['是啊，吃什么', '深度思考碎碎念'],
  },
];

/** 全部随机动作（扁平视图，供目录求交与外部包含判断）。 */
export const ACTS = CATEGORIES.flatMap((category) => category.actions);

/** 带文字动画（镜像会颠倒）：宠物面向右（被镜像）时任何路径都不可播放（含 busy/打断池）。 */
export const NO_MIRROR_ACTS = new Set(CATEGORIES.filter((category) => category.noMirror).flatMap((category) => category.actions));

/** 点击回应动画池（随机抽 1 个）。 */
export const CLICKS = ['点击回应-开心跃动', '点击回应-害羞惊讶', '点击回应-傲娇生气', '点击回应-挠痒咯咯笑', '点击回应-元气挥手'];

/** agent 状态联动池：busy（有 run 进行中）循环播放的工作动画。 */
export const BUSY_ACTS = ['写代码', '深度思考碎碎念', '轻快记录', '原地敲击桌面互动', '吃Token'];
/** 一次性脉冲动画：run 失败炸毛 / run 完成庆祝。 */
export const ERROR_ACT = '被吓一跳';
export const DONE_ACTS = ['点击回应-开心跃动', '哈欠连天'];

/** 移动默认参数：minDist/maxDist=单次行进距离(px)，margin=贴边安全距，leadSec/tailSec=首尾原地时长。 */
export const MOVE_MIN_PX = 60;
export const MOVE_MAX_PX = 240;
export const MOVE_MARGIN = 20;
export const MOVE_LEAD_SEC = 2;
export const MOVE_TAIL_SEC = 2;
export const MOVE_DEFAULT = { minDist: MOVE_MIN_PX, maxDist: MOVE_MAX_PX, margin: MOVE_MARGIN, leadSec: MOVE_LEAD_SEC, tailSec: MOVE_TAIL_SEC };

/** 分动作移动参数（缺省字段回落 MOVE_DEFAULT）：漂浮踏步小碎步、左转奔跑大步流星。 */
export const MOVE_PARAMS = {
  '螃蟹走路': {},
  '原地漂浮踏步': { minDist: 40, maxDist: 120 },
  '原地左转奔跑': { minDist: 120, maxDist: 320 },
};

/** 移动距离的基准宠物宽（px）：实际距离按 size/462 等比缩放（小宠物小步、大宠物大步）。 */
export const BASE_PET_SIZE = 462;

/**
 * 解析指定移动动画的移动参数（含尺寸缩放）。
 * margin 与首尾时长不随缩放（安全距/动画节奏与体型无关）。
 */
export function resolveMoveParams(name, scale = 1) {
  const raw = { ...MOVE_DEFAULT, ...(MOVE_PARAMS[name] ?? {}) };
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    minDist: raw.minDist * factor,
    maxDist: raw.maxDist * factor,
    margin: raw.margin,
    leadSec: raw.leadSec,
    tailSec: raw.tailSec,
  };
}

/** 点击与拖拽的判定阈值（px）。 */
export const DRAG_THRESHOLD = 5;

/**
 * 链式概率边界（同步 dsh-pet 0.2.0 权重 idle 10 / turn 5 / move 5 / action 80）：
 * roll < 0.10 待机 / < 0.15 转向 / < 0.95 动作 / 其余 5% 移动。
 */
export const CHAIN_PROBS = { idle: 0.1, turn: 0.15, act: 0.95 };

/**
 * 生成 [min, max) 区间随机整数（min/max 可为缩放后的非整数）。
 * @param {(n?: number) => number} [rand] 可注入的随机源（默认 Math.random）
 */
export function randomBetween(min, max, rand = Math.random) {
  return Math.floor(min + rand() * (max - min));
}

/**
 * 从池中等概率抽取一个，exclude 排除指定名字（避免连续重复）。
 * 排除后池空（单元素池排除自己）时回退原池——宁可重复也不返回 undefined（同步上游修复）。
 */
export function pick(pool, { exclude = null, rand = Math.random } = {}) {
  const entries = exclude ? pool.filter((name) => name !== exclude) : pool;
  const source = entries.length > 0 ? entries : pool;
  return source[Math.floor(rand() * source.length)];
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
 * 按分类权重选一个动作分类；facing='right'（镜像）时排除 noMirror 分类，
 * 剩余权重自动归一化；无可用分类返回 null。
 */
export function pickCategory(categories, { facing = 'left', rand = Math.random } = {}) {
  const usable = categories.filter((category) => category.actions.length > 0);
  if (usable.length === 0) return null;
  const eligible = usable.filter((category) => !(category.noMirror && facing === 'right'));
  const pool = eligible.length > 0 ? eligible : usable;
  let total = 0;
  const cumulative = pool.map((category) => {
    total += Math.max(0, category.weight);
    return total;
  });
  const roll = rand() * total;
  for (let index = 0; index < pool.length; index += 1) {
    if (roll < cumulative[index]) return pool[index];
  }
  return pool[pool.length - 1];
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
  const categories = CATEGORIES.map((category) => ({ ...category, actions: category.actions.filter((name) => has.has(name)) }))
    .filter((category) => category.actions.length > 0);
  return {
    idle: IDLE,
    turn: has.has(TURN) ? TURN : null,
    categories,
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
 *   idle 走 10/5/80/5 概率链（idle/turn/act/move）。
 * @param {number} [input.scale] 宠物尺寸缩放（size/462），等比缩放移动距离。
 * @returns {{ kind: 'idle'|'turn'|'act', anim: string } | { kind: 'move', plan: object } | { kind: 'act', anim: string, fallback: true }}
 */
export function pickNext({ current, catalog, mood = 'idle', facing = 'left', centerX, centerY, viewportWidth, viewportHeight, halfW, halfH, scale = 1, rand = Math.random }) {
  const roll = rand();
  if (mood === 'busy') {
    // busy：70% 工作动画 / 30% 待机呼吸；不转向、不漫游、不随机动作池
    if (catalog.busy.length > 0 && roll < 0.7) return { kind: 'act', anim: pick(catalog.busy, { exclude: current, rand }) };
    return { kind: 'idle', anim: catalog.idle };
  }
  if (roll < CHAIN_PROBS.idle) return { kind: 'idle', anim: catalog.idle };
  if (roll < CHAIN_PROBS.turn && catalog.turn) return { kind: 'turn', anim: catalog.turn };
  const rollAct = () => {
    // 先按类权重选分类（镜像时滤掉文字类），再在类内按季节权重抽动作
    const category = pickCategory(catalog.categories, { facing, rand });
    const pool = category ? category.actions : catalog.acts;
    if (pool.length === 0) return { kind: 'idle', anim: catalog.idle };
    return { kind: 'act', anim: pickWeighted(pool, { exclude: current, weights: seasonalWeights(), rand }) ?? pick(pool, { rand }) };
  };
  if (roll < CHAIN_PROBS.act || catalog.moves.length === 0) return rollAct();
  const anim = pick(catalog.moves, { rand });
  const plan = planMove({
    current,
    facing,
    centerX,
    centerY,
    viewportWidth,
    viewportHeight,
    halfW,
    halfH,
    move: resolveMoveParams(anim, scale),
    rand,
  });
  return plan ? { kind: 'move', plan, anim } : { ...rollAct(), fallback: true };
}

/**
 * 规划一次屏幕漫游（朝当前朝向）。返回比例制计划（resize 后仍正确），
 * 空间不够时返回 null。
 * @param {{ current: string, facing: 'left'|'right', centerX: number, centerY: number, viewportWidth: number, viewportHeight: number, halfW: number, halfH: number, move?: object, rand?: Function }} input
 */
export function planMove({ current, facing, centerX, centerY, viewportWidth, viewportHeight, halfW, halfH, move = MOVE_DEFAULT, rand = Math.random }) {
  // 方向按“实际朝向”计算：刚播完转向动画（current===TURN）时 facing 即将翻转，方向取反
  const dir = (facing === 'right') !== (current === TURN) ? 1 : -1;
  const distance = randomBetween(move.minDist, move.maxDist, rand);
  const target = centerX + dir * distance;
  const leftBound = move.margin + halfW;
  const rightBound = viewportWidth - move.margin - halfW;
  if (target < leftBound || target > rightBound) return null;
  const topBound = move.margin + halfH;
  const bottomBound = viewportHeight - move.margin - halfH;
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
