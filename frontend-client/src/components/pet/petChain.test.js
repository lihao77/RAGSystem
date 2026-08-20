import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTS,
  CLICKS,
  DRAG,
  DRAG_THRESHOLD,
  IDLE,
  MOVE_MAX_PX,
  MOVE_MIN_PX,
  MOVES,
  TURN,
  buildCatalog,
  feetBottomPad,
  moveProgressRatio,
  pick,
  pickNext,
  pickWeighted,
  planMove,
  randomBetween,
  seasonalWeights,
} from './petChain.js';

const fullCatalog = buildCatalog([...ACTS, IDLE, TURN, ...CLICKS, DRAG, ...MOVES]);
// 固定随机源：序列可控，便于断言
const seqRand = (values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

test('buildCatalog 与可用动画求交，待机缺失时返回 null', () => {
  assert.ok(fullCatalog);
  assert.equal(fullCatalog.idle, IDLE);
  const partial = buildCatalog([IDLE, '写代码', '螃蟹走路']);
  assert.deepEqual(partial.acts, ['写代码']);
  assert.deepEqual(partial.moves, ['螃蟹走路']);
  assert.deepEqual(partial.clicks, []);
  assert.equal(partial.turn, null);
  assert.equal(buildCatalog(['写代码']), null);
});

test('pick 等概率抽取并支持去重，randomBetween 边界正确', () => {
  assert.equal(pick(['a'], { rand: () => 0.9 }), 'a');
  assert.equal(pick(['a', 'b'], { exclude: 'b', rand: () => 0.99 }), 'a');
  assert.equal(randomBetween(60, 240, () => 0), 60);
  assert.equal(randomBetween(60, 240, () => 0.99999), 239);
  assert.ok(DRAG_THRESHOLD > 0 && MOVE_MIN_PX < MOVE_MAX_PX);
});

test('pickNext 按概率区间分派：待机 / 转向 / 动作 / 移动', () => {
  assert.deepEqual(pickNext({ current: IDLE, catalog: fullCatalog, rand: () => 0 }), { kind: 'idle', anim: IDLE });
  assert.deepEqual(pickNext({ current: IDLE, catalog: fullCatalog, rand: () => 0.35 }), { kind: 'turn', anim: TURN });
  const act = pickNext({ current: IDLE, catalog: fullCatalog, rand: () => 0.5 });
  assert.equal(act.kind, 'act');
  assert.ok(ACTS.includes(act.anim));

  // roll>=0.8 走移动分支：planMove 成功 → move；失败 → 回退动作
  const moveRoll = seqRand([0.9, 0.5, 0.0]); // pickNext、planMove 距离、move 池抽取
  const viewport = { centerX: 600, centerY: 900, viewportWidth: 1920, viewportHeight: 1080, halfW: 231, halfH: 130 };
  const move = pickNext({ current: IDLE, catalog: fullCatalog, rand: moveRoll, ...viewport });
  assert.equal(move.kind, 'move');
  assert.ok(MOVES.includes(move.anim));
  assert.ok(move.plan.dir === 1 || move.plan.dir === -1);

  // 贴右缘（无右侧空间）且朝右：planMove 返回 null → 回退随机动作
  const fallback = pickNext({ current: IDLE, catalog: fullCatalog, rand: seqRand([0.9, 0.5, 0.0]), facing: 'right', centerX: 1920 - 20 - 231 + 1, centerY: 900, viewportWidth: 1920, viewportHeight: 1080, halfW: 231, halfH: 130 });
  assert.equal(fallback.kind, 'act');
  assert.ok(fallback.fallback);
});

test('planMove 朝向与转向动画联动，越界返回 null', () => {
  const base = { current: IDLE, centerY: 900, viewportWidth: 1920, viewportHeight: 1080, halfW: 231, halfH: 130 };
  const right = planMove({ ...base, facing: 'right', centerX: 600, rand: () => 0 });
  assert.equal(right.dir, 1);
  assert.equal(right.targetRatio, (600 + 60) / 1920);

  // 刚播完转向动画（facing 即将翻转）：朝右面朝旧方向 → 方向取反
  const afterTurn = planMove({ ...base, facing: 'right', current: TURN, centerX: 600, rand: () => 0 });
  assert.equal(afterTurn.dir, -1);

  assert.equal(planMove({ ...base, facing: 'right', centerX: 1920 - 250, rand: () => 0.99 }), null);
  assert.equal(planMove({ ...base, facing: 'left', centerX: 250, rand: () => 0 }), null);

  // centerY 超出安全边距时被钳制
  const clamped = planMove({ ...base, facing: 'right', centerX: 600, centerY: 0, rand: () => 0 });
  assert.equal(clamped.startYRatio, (20 + 130) / 1080);
});

test('moveProgressRatio 头尾不动、中间线性插值', () => {
  const plan = { dir: 1, startRatio: 0.3, targetRatio: 0.4, totalRatio: 0.1, startYRatio: 0.8 };
  assert.equal(moveProgressRatio({ plan, currentTime: 0, duration: 10 }), 0.3);
  assert.equal(moveProgressRatio({ plan, currentTime: 10, duration: 10 }), 0.4);
  // 移动窗口 2~8s 的中点 t=5：恰好走完一半（0.3 → 0.35）
  const mid = moveProgressRatio({ plan, currentTime: 5, duration: 10 });
  assert.ok(Math.abs(mid - 0.35) < 1e-9);
});

test('busy mood 走工作池且不漫游，idle 保持概率链', () => {
  const catalog = buildCatalog([IDLE, TURN, '写代码', '吃Token', '吃冰淇淋融化', '螃蟹走路', '被吓一跳（炸毛）', '哈欠连天']);
  assert.deepEqual(catalog.busy, ['写代码', '吃Token']);
  assert.equal(catalog.error, '被吓一跳（炸毛）');
  assert.deepEqual(catalog.done, ['哈欠连天']);

  const busyAct = pickNext({ current: IDLE, catalog, mood: 'busy', rand: () => 0.5 });
  assert.equal(busyAct.kind, 'act');
  assert.ok(catalog.busy.includes(busyAct.anim));
  assert.deepEqual(pickNext({ current: IDLE, catalog, mood: 'busy', rand: () => 0.9 }), { kind: 'idle', anim: IDLE });

  const viewport = { centerX: 600, centerY: 900, viewportWidth: 1920, viewportHeight: 1080, halfW: 231, halfH: 130 };
  assert.equal(pickNext({ current: IDLE, catalog, mood: 'idle', rand: seqRand([0.95, 0.5, 0.0]), ...viewport }).kind, 'move');
  // busy 下同样的 roll 永不进入移动分支
  assert.notEqual(pickNext({ current: IDLE, catalog, mood: 'busy', rand: () => 0.95, ...viewport }).kind, 'move');
});

test('pickWeighted 按权重落点，seasonalWeights 按月份/时段加成', () => {
  // 权重 9:1 时，接近 1 的落点必然命中高权项
  assert.equal(pickWeighted(['a', 'b'], { weights: { b: 9 }, rand: () => 0.99 }), 'b');
  assert.equal(pickWeighted(['a', 'b'], { weights: { b: 9 }, rand: () => 0 }), 'a');
  assert.equal(pickWeighted(['a', 'b'], { weights: { a: 0 }, rand: () => 0.01 }), 'b'); // 权重 0 不可选中
  assert.equal(pickWeighted([], {}), undefined);

  // 冬夜（1 月 23 点）：堆雪人 + 深夜小憩/哈欠加成
  const winterNight = seasonalWeights(new Date(2026, 0, 15, 23, 0));
  assert.ok(winterNight['堆雪人'] > 0);
  assert.ok(winterNight['原地小憩沉眠'] > 0);
  assert.ok(winterNight['哈欠连天'] > 0);
  assert.equal(winterNight['摇扇纳凉'], undefined);

  // 夏日午间（7 月 14 点）：摇扇/冰淇淋，无夜间项
  const summer = seasonalWeights(new Date(2026, 6, 15, 14, 0));
  assert.ok(summer['摇扇纳凉'] > 0 && summer['吃冰淇淋融化'] > 0);
  assert.equal(summer['原地小憩沉眠'], undefined);

  // 九月：中秋专属动画
  assert.ok(seasonalWeights(new Date(2026, 8, 20, 10, 0))['中秋赏月吃月饼'] > 0);
});

test('feetBottomPad 按 8.33% 画布底距换算', () => {
  assert.ok(Math.abs(feetBottomPad(260) - 21.6666) < 0.001);
});
