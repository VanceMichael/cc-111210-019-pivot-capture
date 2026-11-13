import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';
import { openBrowser } from './browser.mjs';
import { collectLeaves } from './collector.mjs';
import { ReceiptStore } from './store.mjs';

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
const service = await startService({ source: source.url, directory });
const store = new ReceiptStore(directory);
let browserSession;

function summarize(report) {
  const { counts } = report.completeness;
  return {
    generation: report.context.generation,
    dimensionOrder: report.context.dimensionOrder,
    leaves: report.leaves.map(leaf => ({
      path: leaf.canonicalPath,
      state: leaf.state,
      value: leaf.value,
      isZero: leaf.isZero,
      source: leaf.screenSource.rowKey,
    })),
    reconciliation: report.reconciliation,
    coverage: report.coverage,
    counts,
    gaps: report.completeness.gaps,
    abortedRounds: report.abortedRounds,
  };
}

try {
  // 场景一：展开过程中源数据版被刷新 —— 第一轮必须作废，保留证据，再启动一致的一轮
  const interrupted = await collectLeaves(source.url, {
    onBeforeExpand: async ({ page, rootKey, generation, attempt }) => {
      if (attempt === 1 && rootKey === '甲馆') {
        await page.locator('#refresh').click();
        await page.waitForFunction(expected => document.querySelector('[data-generation]')?.getAttribute('data-generation') !== expected, generation);
      }
    },
  });

  // 场景二：维度重排（date 提到首层），行身份仍按 museum/zone/date 归一
  browserSession = await openBrowser(source.url);
  await browserSession.page.locator('#dimensions').click();
  await browserSession.page.locator('[data-grain="date"]').first().waitFor();
  await browserSession.close();
  browserSession = undefined;

  const reordered = await collectLeaves(source.url);
  const receipt = await store.save('leaf-demo', reordered);

  const suppressedDemo = reordered.leaves.find(leaf => leaf.state === 'suppressed');
  const zeroDemo = reordered.leaves.find(leaf => leaf.isZero);

  const output = {
    service: service.url,
    scenario1RefreshDuringExpansion: {
      abortedRounds: interrupted.abortedRounds.map(round => ({
        reason: round.reason,
        expectedGeneration: round.expectedGeneration,
        observedGeneration: round.observedGeneration,
        stage: round.stage,
        visibleRowsAtAbort: round.visibleRows,
      })),
      restartedConsistentRound: interrupted.attempts,
      finalGeneration: interrupted.context.generation,
    },
    scenario2DimensionReorder: {
      reorderedOrderOnPage: reordered.context.dimensionOrder,
      canonicalIdentityExample: reordered.leaves.map(leaf => leaf.identity),
    },
    scenario3SuppressedAndZero: {
      suppressed: suppressedDemo ? { path: suppressedDemo.canonicalPath, rawState: suppressedDemo.rawState } : null,
      realZero: zeroDemo ? { path: zeroDemo.canonicalPath, value: zeroDemo.value } : null,
    },
    financeView: summarize(reordered),
    receipt: { key: receipt.key, digest: receipt.digest, file: join(directory, receipt.key + '.json') },
  };

  console.log(JSON.stringify(output, null, 2));
} finally {
  await browserSession?.close();
  await service.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
