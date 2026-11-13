import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { collectLeaves, CANONICAL_DIMENSIONS } from './collector.mjs';
import { ReceiptStore } from './store.mjs';

function parseGrain(value) {
  if (!value) return CANONICAL_DIMENSIONS;
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  return listen(async url => {
    if (url.pathname === '/health') return { body: { state: 'ready' } };
    if (url.pathname === '/inspect') {
      // 原始屏幕查看：可见行原样读取，不声称完成明细采集
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/collect') {
      const result = await collectLeaves(source, { targetGrain: parseGrain(url.searchParams.get('grain')) });
      return { body: result };
    }
    if (url.pathname === '/collect/receive') {
      const key = url.searchParams.get('key') ?? 'leaf-collection';
      const result = await collectLeaves(source, { targetGrain: parseGrain(url.searchParams.get('grain')) });
      return { body: await store.save(key, result) };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }
    if (url.pathname.startsWith('/receipts/')) return { body: await store.read(url.pathname.split('/').pop()) };
    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
