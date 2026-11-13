import { openBrowser } from './browser.mjs';

// 语义上稳定的维度顺序：页面维度可重排，叶项身份按此顺序归一
export const CANONICAL_DIMENSIONS = ['museum', 'zone', 'date'];
const MAX_ROUNDS = 3;
const LAZY_WAIT_MS = 2000;
const LAZY_PROBE_MS = 80;

// 采集被中断（版次/筛选/维度顺序变化）或粒度不支持时抛出，evidence 保留失败轮证据
export class CollectionAborted extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'CollectionAborted';
    this.evidence = evidence;
  }
}

function parseTrailingNumber(text) {
  // 叶项文本形如 "甲馆 / A区 / 2026-11-13: 12"，只能取冒号后的部分，避免把日期里的数字当成指标
  const portion = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : text;
  const match = portion.trim().match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

async function readContext(page) {
  const section = page.locator('[data-query]').first();
  const attrs = await section.evaluate(el => ({
    query: el.getAttribute('data-query'),
    generation: el.getAttribute('data-generation'),
    dimensions: (el.getAttribute('data-dimensions') ?? '').split(',').filter(Boolean),
  }));
  // 筛选芯片（当前演练页只有 data-query，保留读取位以便页面将来增加筛选控件）
  const filters = await page
    .locator('[data-filter-selected]')
    .evaluateAll(els => els.map(el => el.textContent.trim()))
    .catch(() => []);
  return { ...attrs, filters };
}

async function readVisibleRows(page) {
  return page
    .locator('[data-pivot-row]')
    .evaluateAll(els => els.map(el => el.textContent.trim()))
    .catch(() => []);
}

function classifyLeaf(raw, displayDimensions) {
  const state = raw.state;
  const text = raw.text;
  const displayPath = raw.path;
  const byDimension = {};
  displayPath.forEach((value, index) => {
    byDimension[displayDimensions[index]] = value;
  });
  const canonicalPath = CANONICAL_DIMENSIONS.map(dimension => byDimension[dimension]).filter(value => value !== undefined);
  let leafState;
  let value = null;
  if (state === 'suppressed') leafState = 'suppressed'; // 抑制展示：页面明确不给数
  else if (state === 'missing') leafState = 'missing'; // 空值/缺测
  else if (state === 'value') {
    value = parseTrailingNumber(text);
    leafState = value === null ? 'unparseable' : 'value';
  } else leafState = state ?? 'unknown';
  return {
    identity: canonicalPath.join('/'),
    canonicalPath,
    pathByDimension: byDimension,
    displayedPath: displayPath,
    state: leafState,
    value,
    isZero: leafState === 'value' && value === 0, // 真实零值与空值区分
    rawState: state,
    screenSource: {
      rowKey: raw.key,
      grain: raw.grain,
      version: raw.version,
      text,
    },
  };
}

// 在浏览器上下文内执行的纯函数：只能引用自身参数，不能引用 Node 闭包
function readLeafRaw() {
  return [...document.querySelectorAll('[data-pivot-row][data-state]')].map(el => ({
    key: el.getAttribute('data-key'),
    grain: el.getAttribute('data-grain'),
    version: el.getAttribute('data-version'),
    state: el.getAttribute('data-state'),
    path: JSON.parse(el.getAttribute('data-path') ?? '[]'),
    text: el.textContent.trim(),
  }));
}

async function runRound(page, { targetGrain, onBeforeExpand, attempt }) {
  const label = `round-${attempt}`;
  const start = await readContext(page);
  const initialGeneration = start.generation;
  const leafGrain = start.dimensions.join(',');
  const firstDimension = start.dimensions[0] ?? '';

  const snapshot = stage => ({
    round: label,
    stage,
    expectedGeneration: initialGeneration,
    observedContext: start,
    collectedAt: new Date().toISOString(),
  });

  // 目标粒度校验：只产出页面真正的叶粒度，粗粒度请求无法由本页面证明，直接拒绝
  if (targetGrain && [...targetGrain].sort().join(',') !== [...start.dimensions].sort().join(',')) {
    throw new CollectionAborted(
      `目标粒度 ${targetGrain.join(',')} 与页面叶粒度 ${leafGrain} 不一致，拒绝以小计冒充明细`,
      { ...snapshot('validate-grain'), reason: 'grain-mismatch', targetGrain },
    );
  }

  const checkpoint = async stage => {
    const now = await readContext(page);
    const evidence = {
      ...snapshot(stage),
      observedGeneration: now.generation,
      observedDimensions: now.dimensions,
      observedQuery: now.query,
      observedFilters: now.filters,
      visibleRows: await readVisibleRows(page),
    };
    const reasons = [];
    if (now.dimensions.join(',') !== start.dimensions.join(',')) reasons.push('dimension-reordered');
    if (now.generation !== initialGeneration) reasons.push('generation-changed');
    if (now.query !== start.query || JSON.stringify(now.filters) !== JSON.stringify(start.filters)) reasons.push('filter-changed');
    if (reasons.length > 0) {
      evidence.reasons = reasons;
      evidence.reason = reasons[0];
      throw new CollectionAborted(
        `页面一致性被破坏（${reasons.join('、')}），本轮已采片段全部作废`,
        evidence,
      );
    }
    return now;
  };

  // 沿展开路径取根节点（小计行）：grain 只含首层维度，选择器在展开前后保持稳定，不依赖行的相邻位置
  const rootSelector = `[data-pivot-row][data-grain="${firstDimension}"]`;
  const rootKeys = await page.locator(rootSelector).evaluateAll(els =>
    els.map(el => el.getAttribute('data-key')),
  );

  const leafSelector = `[data-pivot-row][data-grain="${leafGrain}"][data-version="${initialGeneration}"]`;
  const leavesByIdentity = new Map();
  const lazyLoads = [];
  const expandedRoots = [];

  for (const rootKey of rootKeys) {
    await checkpoint(`before-expand:${rootKey}`);
    if (onBeforeExpand) {
      await onBeforeExpand({ page, rootKey, generation: initialGeneration, attempt, dimensions: start.dimensions });
    }
    await checkpoint(`after-hook:${rootKey}`);

    const expandButton = page.locator(`[data-expand="${rootKey}"]`);
    await expandButton.click();

    // 懒加载占位：按钮在数据到达前处于禁用的“加载中”态，它不是业务行，不得计入明细
    let lazyObserved = false;
    let placeholderText = null;
    try {
      const disabled = page.locator(`[data-expand="${rootKey}"]:disabled`).first();
      await disabled.waitFor({ state: 'visible', timeout: LAZY_PROBE_MS });
      lazyObserved = true;
      placeholderText = await disabled.textContent().catch(() => null);
    } catch {
      // 未在探测窗口内捕获到占位，说明加载快于探测，不影响后续行身份校验
    }
    lazyLoads.push({ rootKey, observed: lazyObserved, placeholderText });

    // 等待本根节点的叶项真正出现（按数量增长判断，而不是假定相邻行位置）
    const beforeCount = await page.locator(leafSelector).count();
    try {
      await page.waitForFunction(
        ({ selector, baseline }) => document.querySelectorAll(selector).length > baseline,
        { selector: leafSelector, baseline: beforeCount },
        { timeout: LAZY_WAIT_MS },
      );
    } catch {
      throw new CollectionAborted(`节点 ${rootKey} 懒加载超时，未取得叶项`, {
        ...snapshot(`lazy-timeout:${rootKey}`),
        reason: 'lazy-load-timeout',
        rootKey,
        visibleRows: await readVisibleRows(page),
      });
    }

    const allRaw = await page.evaluate(readLeafRaw);
    const fresh = allRaw
      .filter(raw => raw.grain === leafGrain && raw.version === initialGeneration)
      .map(raw => classifyLeaf(raw, start.dimensions));
    for (const leaf of fresh) {
      if (!leavesByIdentity.has(leaf.identity)) {
        leaf.screenSource.expandedFrom = rootKey;
        leavesByIdentity.set(leaf.identity, leaf);
      }
    }
    expandedRoots.push(rootKey);
    await checkpoint(`after-expand:${rootKey}`);
  }

  // 控制行：总计与小计只用于核对，绝不进入叶项集合
  const totalEl = page.locator('[data-pivot-row][data-grain="total"]');
  const total =
    (await totalEl.count()) > 0
      ? await totalEl.first().evaluate(el => {
          const text = el.textContent.trim();
          const numericCell = el.querySelector('[data-value]');
          const numberText = numericCell?.getAttribute('data-value')?.trim();
          // 没有独立指标单元格时，仅当文本里的数字明确跟在“总计”标记后才采信（演练页形态）
          const fallback = text.match(/总计\s*(-?\d+(?:\.\d+)?)/);
          const displayedNumber = numberText != null && /^-?\d+(?:\.\d+)?$/.test(numberText)
            ? Number(numberText)
            : fallback
              ? Number(fallback[1])
              : null;
          return {
            rowKey: el.getAttribute('data-key'),
            version: el.getAttribute('data-version'),
            text,
            displayedNumber,
          };
        })
      : null;

  const subtotals = await page
    .locator(rootSelector)
    .evaluateAll(els =>
      els.map(el => {
        const text = el.textContent.trim();
        // 小计行结构为“展开/折叠 + 名称 + 小计”，指标列才是数字；当前页面小计没有指标列。
        // 名称里可能含日期等数字，不能把文本中的任意数字当作小计值。
        const numericCell = el.querySelector('[data-value]');
        const numberText = numericCell?.getAttribute('data-value')?.trim();
        const parsed = numberText != null && numberText !== '' && /^-?\d+(?:\.\d+)?$/.test(numberText)
          ? Number(numberText)
          : null;
        return {
          rowKey: el.getAttribute('data-key'),
          version: el.getAttribute('data-version'),
          text,
          displayedNumber: parsed,
        };
      }),
    );

  // Top-N 覆盖边界：剩余项是页面声明的不可展开项，只能说明边界，不能分摊进明细
  const coverageLocator = page.locator('[data-coverage]');
  let coverage = null;
  if ((await coverageLocator.count()) > 0) {
    coverage = await coverageLocator.first().evaluate(el => ({
      kind: el.getAttribute('data-coverage'),
      remaining: Number(el.getAttribute('data-remaining') ?? 0),
      text: el.textContent.trim(),
    }));
  }

  await checkpoint('final');

  const leaves = [...leavesByIdentity.values()];
  const numericLeaves = leaves.filter(leaf => leaf.state === 'value');
  const suppressedLeaves = leaves.filter(leaf => leaf.state === 'suppressed');
  const missingLeaves = leaves.filter(leaf => leaf.state === 'missing' || leaf.state === 'unparseable');
  const leafNumericSum = numericLeaves.reduce((sum, leaf) => sum + leaf.value, 0);
  const remaining = coverage?.remaining ?? 0;
  const gaps = [
    ...suppressedLeaves.map(leaf => ({ identity: leaf.identity, reason: 'suppressed', detail: '单元格被抑制展示，页面未提供数值' })),
    ...missingLeaves.map(leaf => ({ identity: leaf.identity, reason: leaf.state, detail: '空值或缺测，不是真实零值' })),
    ...(remaining > 0 ? [{ identity: null, reason: 'top-n-remaining', detail: `页面声明另有 ${remaining} 项不予展开，无采集入口` }] : []),
  ];

  return {
    report: 'pivot-leaf-collection',
    targetGrain: CANONICAL_DIMENSIONS.join(','),
    context: {
      sourceQuery: start.query,
      filters: start.filters,
      dimensionOrder: start.dimensions,
      canonicalDimensions: CANONICAL_DIMENSIONS,
      generation: initialGeneration,
      collectedAt: new Date().toISOString(),
    },
    leaves: leaves.map(({ identity, canonicalPath, pathByDimension, displayedPath, state, value, isZero, rawState, screenSource }) => ({
      identity,
      canonicalPath,
      pathByDimension,
      displayedPath,
      state,
      value,
      isZero,
      rawState,
      screenSource,
    })),
    controls: { total, subtotals },
    reconciliation: {
      leafNumericSum,
      totalDisplayed: total?.displayedNumber ?? null,
      subtotalsDisplayed: subtotals.map(item => ({ rowKey: item.rowKey, displayedNumber: item.displayedNumber })),
      difference: total?.displayedNumber == null ? null : total.displayedNumber - leafNumericSum,
      note: '差额只能由 Top-N 剩余项与被抑制/缺测单元格解释，禁止按小计反摊',
    },

    coverage: coverage
      ? {
          kind: coverage.kind,
          remainingItems: coverage.remaining,
          sourceText: coverage.text,
          boundaryExplained: true,
          note: '剩余项页面不提供展开入口，本报告不包含其明细，也不做分摊估算',
        }
      : { kind: null, remainingItems: 0, boundaryExplained: true },
    completeness: {
      complete: gaps.length === 0,
      counts: {
        leaves: leaves.length,
        numericLeaves: numericLeaves.length,
        realZeroLeaves: numericLeaves.filter(leaf => leaf.isZero).length,
        suppressedLeaves: suppressedLeaves.length,
        missingLeaves: missingLeaves.length,
        topNRemaining: remaining,
      },
      gaps,
    },
    collapsedNodes: {
      expandedRoots,
      collapsedRoots: rootKeys.filter(key => !expandedRoots.includes(key)),
    },
    lazyLoads,
    attempts: attempt,
    abortedRounds: [],
  };
}

// 对外入口：一轮必须自始至终处于同一版次/筛选/维度顺序；中断则保留证据并重新开始一致的一轮
export async function collectLeaves(base, options = {}) {
  const targetGrain = options.targetGrain ?? CANONICAL_DIMENSIONS;
  const session = await openBrowser(base);
  const abortedRounds = [];
  try {
    for (let attempt = 1; attempt <= MAX_ROUNDS; attempt += 1) {
      try {
        const report = await runRound(session.page, { targetGrain, onBeforeExpand: options.onBeforeExpand, attempt });
        report.abortedRounds = abortedRounds;
        report.attempts = attempt;
        return report;
      } catch (error) {
        if (!(error instanceof CollectionAborted) || error.evidence?.reason === 'grain-mismatch') throw error;
        abortedRounds.push(error.evidence);
        await session.page.reload();
        await session.page.locator('[data-ready="true"]').waitFor();
      }
    }
    throw new CollectionAborted(`连续 ${MAX_ROUNDS} 轮采集中断，已保留各失败版本证据`, {
      reason: 'round-limit',
      abortedRounds,
    });
  } finally {
    await session.close();
  }
}
