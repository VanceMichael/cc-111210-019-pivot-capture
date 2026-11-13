import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../fixtures/source.mjs';
import { openBrowser } from '../src/browser.mjs';
import { collectLeaves, CollectionAborted, CANONICAL_DIMENSIONS } from '../src/collector.mjs';

test('叶项采集只产出叶粒度并区分零值抑制缺测', async () => {
  const source = await startFixture();
  try {
    const report = await collectLeaves(source.url);
    assert.equal(report.report, 'pivot-leaf-collection');
    assert.equal(report.targetGrain, CANONICAL_DIMENSIONS.join(','));
    // 总计与小计不混入叶项
    assert.ok(!report.leaves.some(leaf => leaf.screenSource.grain === 'total'));
    assert.ok(!report.leaves.some(leaf => leaf.screenSource.rowKey.includes('小计')));
    assert.equal(report.leaves.length, 4);
    const byIdentity = Object.fromEntries(report.leaves.map(leaf => [leaf.identity, leaf]));
    assert.equal(byIdentity['甲馆/A区/2026-11-13'].state, 'value');
    assert.equal(byIdentity['甲馆/A区/2026-11-13'].value, 12);
    const zero = byIdentity['甲馆/A区/2026-11-14'];
    assert.equal(zero.state, 'value');
    assert.equal(zero.value, 0);
    assert.equal(zero.isZero, true);
    const suppressed = byIdentity['甲馆/B区/2026-11-13'];
    assert.equal(suppressed.state, 'suppressed');
    assert.equal(suppressed.value, null);
    const missing = byIdentity['乙馆/A区/2026-11-13'];
    assert.equal(missing.state, 'missing');
    assert.equal(missing.value, null);
    // 屏幕来源与维度路径齐备
    for (const leaf of report.leaves) {
      assert.equal(leaf.canonicalPath.length, 3);
      assert.ok(leaf.screenSource.rowKey);
      assert.equal(leaf.screenSource.version, report.context.generation);
      assert.ok(leaf.screenSource.expandedFrom);
    }
    // 小计/总计只作核对
    assert.equal(report.controls.total.displayedNumber, 24);
    assert.equal(report.reconciliation.leafNumericSum, 12);
    assert.equal(report.reconciliation.difference, 12);
    // Top-N 覆盖边界被主动说明，且不摊为明细
    assert.equal(report.coverage.remainingItems, 2);
    assert.equal(report.coverage.boundaryExplained, true);
    assert.ok(report.completeness.gaps.some(gap => gap.reason === 'top-n-remaining'));
    assert.equal(report.completeness.complete, false);
    assert.deepEqual(report.completeness.counts, {
      leaves: 4, numericLeaves: 2, realZeroLeaves: 1, suppressedLeaves: 1, missingLeaves: 1, topNRemaining: 2,
    });
  } finally {
    await source.close();
  }
});

test('展开中刷新导致版次变化时作废片段并重启一致的一轮', async () => {
  const source = await startFixture();
  try {
    const report = await collectLeaves(source.url, {
      onBeforeExpand: async ({ page, rootKey, generation, attempt }) => {
        if (attempt === 1 && rootKey === '甲馆') {
          await page.locator('#refresh').click();
          await page
            .locator('[data-generation]')
            .first()
            .waitFor({ state: 'visible' });
          await page.waitForFunction(expected => document.querySelector('[data-generation]')?.getAttribute('data-generation') !== expected, generation);
        }
      },
    });
    assert.equal(report.attempts, 2);
    assert.equal(report.abortedRounds.length, 1);
    const evidence = report.abortedRounds[0];
    assert.equal(evidence.reason, 'generation-changed');
    assert.equal(Number(evidence.observedGeneration), Number(evidence.expectedGeneration) + 1);
    assert.ok(evidence.visibleRows.length > 0);
    // 重启后所有叶项来自同一新版次，旧片段未混用
    assert.equal(report.context.generation, evidence.observedGeneration);
    assert.ok(report.leaves.every(leaf => leaf.screenSource.version === report.context.generation));
    assert.equal(report.leaves.length, 4);
  } finally {
    await source.close();
  }
});

test('维度重排后行身份按规范维度归一', async () => {
  const source = await startFixture();
  let session;
  try {
    session = await openBrowser(source.url);
    await session.page.locator('#dimensions').click();
    await session.page.locator('[data-grain="date"]').first().waitFor();
    await session.close();
    session = undefined;
    const report = await collectLeaves(source.url);
    assert.deepEqual(report.context.dimensionOrder, ['date', 'zone', 'museum']);
    assert.deepEqual(report.context.canonicalDimensions, CANONICAL_DIMENSIONS);
    // 屏幕展示路径以 date 开头，规范身份仍是 museum/zone/date
    const leaf = report.leaves.find(item => item.state === 'suppressed');
    assert.equal(leaf.displayedPath[0], '2026-11-13');
    assert.deepEqual(leaf.canonicalPath, ['甲馆', 'B区', '2026-11-13']);
    assert.equal(leaf.identity, '甲馆/B区/2026-11-13');
    assert.ok(leaf.pathByDimension.museum && leaf.pathByDimension.zone && leaf.pathByDimension.date);
    // 小计行名称含日期，不能把年份解析成小计指标
    assert.ok(report.controls.subtotals.every(item => item.displayedNumber === null));
  } finally {
    await session?.close();
    await source.close();
  }
});

test('非叶粒度请求被拒绝而不是用小计冒充明细', async () => {
  const source = await startFixture();
  try {
    await assert.rejects(
      collectLeaves(source.url, { targetGrain: ['museum'] }),
      error => error instanceof CollectionAborted && error.evidence.reason === 'grain-mismatch',
    );
  } finally {
    await source.close();
  }
});

test('懒加载占位被识别且不计入业务行', async () => {
  const source = await startFixture();
  try {
    const report = await collectLeaves(source.url);
    assert.ok(report.lazyLoads.length >= 2);
    assert.ok(report.lazyLoads.some(item => item.observed && /加载中/.test(item.placeholderText ?? '')));
    assert.ok(report.leaves.every(leaf => !/加载中/.test(leaf.screenSource.text)));
    assert.deepEqual(report.collapsedNodes.collapsedRoots, []);
    assert.equal(report.collapsedNodes.expandedRoots.length, report.controls.subtotals.length);
  } finally {
    await source.close();
  }
});

test('维度顺序在采集过程中变化同样中断留证并以新顺序重启', async () => {
  const source = await startFixture();
  try {
    const report = await collectLeaves(source.url, {
      onBeforeExpand: async ({ page, rootKey, attempt }) => {
        if (attempt === 1 && rootKey === '甲馆') {
          await page.locator('#dimensions').click();
          await page.locator('[data-grain="date"]').first().waitFor();
        }
      },
    });
    assert.equal(report.abortedRounds.length, 1);
    assert.equal(report.abortedRounds[0].reason, 'dimension-reordered');
    assert.deepEqual(report.context.dimensionOrder, ['date', 'zone', 'museum']);
    assert.equal(report.leaves.length, 4);
    assert.ok(report.leaves.every(leaf => leaf.screenSource.version === report.context.generation));
  } finally {
    await source.close();
  }
});
