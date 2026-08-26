import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTS,
  BASE_PET_SIZE,
  CATEGORIES,
  CLICKS,
  DRAG,
  DRAG_THRESHOLD,
  IDLE,
  MOVE_DEFAULT,
  MOVE_MAX_PX,
  MOVE_MIN_PX,
  MOVES,
  NO_MIRROR_ACTS,
  TURN,
  buildCatalog,
  feetBottomPad,
  moveProgressRatio,
  pick,
  pickCategory,
  pickNext,
  pickWeighted,
  planMove,
  randomBetween,
  resolveMoveParams,
  seasonalWeights,
} from '../ui/src/petChain.js';

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
  // 分类池同步求交：写代码归入「小动作」，其余类被整体丢弃
  assert.deepEqual(partial.categories.map((c) => c.id), ['小动作']);
  assert.deepEqual(partial.categories[0].actions, ['写代码']);
  assert.equal(buildCatalog(['写代码']), null);
});

test('pick 等概率抽取并支持去重，单元素池排除自身时回退原池（不返回 undefined）', () => {
  assert.equal(pick(['a'], { rand: () => 0.9 }), 'a');
  assert.equal(pick(['a', 'b'], { exclude: 'b', rand: () => 0.99 }), 'a');
  assert.equal(pick(['a'], { exclude: 'a', rand: () => 0.9 }), 'a');
  assert.equal(randomBetween(60, 240, () => 0), 60);
  assert.equal(randomBetween(60, 240, () => 0.99999), 239);
  assert.ok(DRAG_THRESHOLD > 0 && MOVE_MIN_PX < MOVE_MAX_PX);
});

test('pickCategory 按类权重落点，镜像时排除 noMirror 文字类', () => {
  // 权重 20/20/16/14/10（合计 80）：rand=0 取首类，接近 1 取末类
  assert.equal(pickCategory(CATEGORIES, { rand: () => 0 }).id, '小动作');
  assert.equal(pickCategory(CATEGORIES, { rand: () => 0.999 }).id, '文字');
  // facing=right（镜像）：文字类被排除，接近 1 落在末个可类（时节）
  assert.equal(pickCategory(CATEGORIES, { facing: 'right', rand: () => 0.999 }).id, '时节');
  // 全部为 noMirror 时回退全集，不返回 null
  const allNoMirror = [{ id: 'x', weight: 1, noMirror: true, actions: ['a'] }];
  assert.equal(pickCategory(allNoMirror, { facing: 'right', rand: () => 0 }).id, 'x');
  assert.equal(pickCategory([], { rand: () => 0 }), null);
  // 空动作分类不参与抽取
  const withEmpty = [...CATEGORIES, { id: '空', weight: 99, actions: [] }];
  assert.equal(pickCategory(withEmpty, { rand: () => 0.999 }).id, '文字');
});

test('pickNext 按概率区间分派：待机 / 转向 / 动作 / 移动', () => {
  assert.deepEqual(pickNext({ current: IDLE, catalog: fullCatalog, rand: () => 0 }), { kind: 'idle', anim: IDLE });
  assert.deepEqual(pickNext({ current: IDLE, catalog: fullCatalog, rand: seqRand([0.12]) }), { kind: 'turn', anim: TURN });

  // roll<0.95 走动作分支：roll → pickCategory → pickWeighted 共消耗 3 个随机数
  const act = pickNext({ current: IDLE, catalog: fullCatalog, rand: seqRand([0.5, 0.0, 0.0]) });
  assert.equal(act.kind, 'act');
  assert.ok(ACTS.includes(act.anim));

  // roll>=0.95 走移动分支：roll → pick(moves) → planMove 距离
  const viewport = { centerX: 600, centerY: 900, viewportWidth: 1920, viewportHeight: 1080, halfW: 231, halfH: 130 };
  const move = pickNext({ current: IDLE, catalog: fullCatalog, rand: seqRand([0.97, 0.0, 0.0]), ...viewport });
  assert.equal(move.kind, 'move');
  assert.ok(MOVES.includes(move.anim));
  assert.ok(move.plan.dir === 1 || move.plan.dir === -1);

  // 贴右缘（无右侧空间）且朝右：planMove 返回 null → 回退随机动作
  const fallback = pickNext({
    current: IDLE,
    catalog: fullCatalog,
    rand: seqRand([0.97, 0.5, 0.5, 0.0, 0.0]),
    facing: 'right',
    centerX: 1920 - 20 - 231 + 1,
    centerY: 900,
    viewportWidth: 1920,
    viewportHeight: 1080,
    halfW: 231,
    halfH: 130,
  });
  assert.equal(fallback.kind, 'act');
  assert.ok(fallback.fallback);
});

test('planMove 朝向与转向动画联动，支持分动作参数，越界返回 null', () => {
  const base = { current: IDLE, centerY: 900, viewportWidth: 1920, viewportHeight: 1080, halfW: 231, halfH: 130 };
  const right = planMove({ ...base, facing: 'right', centerX: 600, rand: () => 0 });
  assert.equal(right.dir, 1);
  assert.equal(right.targetRatio, (600 + 60) / 1920);

  // 刚播完转向动画（facing 即将翻转）：朝右面朝旧方向 → 方向取反
  const afterTurn = planMove({ ...base, facing: 'right', current: TURN, centerX: 600, rand: () => 0 });
  assert.equal(afterTurn.dir, -1);

  // 分动作参数：左转奔跑 rand=0 → 最短 120px
  const run = planMove({ ...base, facing: 'right', centerX: 600, move: resolveMoveParams('原地左转奔跑'), rand: () => 0 });
  assert.equal(run.targetRatio, (600 + 120) / 1920);

  assert.equal(planMove({ ...base, facing: 'right', centerX: 1920 - 250, rand: () => 0.99 }), null);
  assert.equal(planMove({ ...base, facing: 'left', centerX: 250, rand: () => 0 }), null);

  // centerY 超出安全边距时被钳制
  const clamped = planMove({ ...base, facing: 'right', centerX: 600, centerY: 0, rand: () => 0 });
  assert.equal(clamped.startYRatio, (20 + 130) / 1080);
});

test('resolveMoveParams 按动作覆盖默认参数，距离随尺寸缩放、边距不缩放', () => {
  assert.deepEqual(resolveMoveParams('螃蟹走路'), MOVE_DEFAULT);
  assert.equal(resolveMoveParams('原地漂浮踏步').minDist, 40);
  assert.equal(resolveMoveParams('原地漂浮踏步').maxDist, 120);
  const big = resolveMoveParams('原地左转奔跑', 2);
  assert.equal(big.minDist, 240);
  assert.equal(big.maxDist, 640);
  assert.equal(big.margin, MOVE_DEFAULT.margin);
  assert.equal(BASE_PET_SIZE, 462);
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
  const catalog = buildCatalog([IDLE, TURN, '写代码', '吃Token', '吃冰淇淋融化', '螃蟹走路', '被吓一跳', '哈欠连天']);
  assert.deepEqual(catalog.busy, ['写代码', '吃Token']);
  assert.equal(catalog.error, '被吓一跳');
  assert.deepEqual(catalog.done, ['哈欠连天']);

  const busyAct = pickNext({ current: IDLE, catalog, mood: 'busy', rand: () => 0.5 });
  assert.equal(busyAct.kind, 'act');
  assert.ok(catalog.busy.includes(busyAct.anim));
  assert.deepEqual(pickNext({ current: IDLE, catalog, mood: 'busy', rand: () => 0.9 }), { kind: 'idle', anim: IDLE });

  const viewport = { centerX: 600, centerY: 900, viewportWidth: 1920, viewportHeight: 1080, halfW: 231, halfH: 130 };
  assert.equal(pickNext({ current: IDLE, catalog, mood: 'idle', rand: seqRand([0.97, 0.0, 0.0]), ...viewport }).kind, 'move');
  // busy 下同样的 roll 永不进入移动分支
  assert.notEqual(pickNext({ current: IDLE, catalog, mood: 'busy', rand: () => 0.97, ...viewport }).kind, 'move');
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

test('NO_MIRROR_ACTS 覆盖全部文字类动画（镜像朝向不可播放）', () => {
  assert.ok(NO_MIRROR_ACTS.has('是啊，吃什么'));
  assert.ok(NO_MIRROR_ACTS.has('深度思考碎碎念'));
  assert.equal(NO_MIRROR_ACTS.has('写代码'), false);
  assert.equal(NO_MIRROR_ACTS.size, 2);
});

test('feetBottomPad 按 8.33% 画布底距换算', () => {
  assert.ok(Math.abs(feetBottomPad(260) - 21.6666) < 0.001);
});
