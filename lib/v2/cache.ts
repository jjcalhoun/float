/* Don't detect the same series twice.
 *
 * detectSeries is the expensive thing in v2 — around 60ms over two years of
 * history on a laptop, so several hundred on a phone — and both the Float
 * screen and the Recurring screen run it on every mount. Switching between
 * them paid that cost again each time, for an answer that could not have
 * changed: the transactions were the same array.
 *
 * Which is the trick. React Query hands back a stable reference while the
 * query is cached, so the array itself identifies the input. A WeakMap keyed
 * on it means the results are dropped the moment a refetch replaces the
 * array, with no invalidation to get wrong and nothing to grow for ever.
 *
 * The string key covers everything else the computation depends on — which
 * accounts are in scope, which variant of the filtering a screen uses. Get
 * that wrong and one screen reads another's answer, so callers build it from
 * every input they actually use.
 */

const cache = new WeakMap<object, Map<string, unknown>>();

export function memoByTxns<T>(txns: object, key: string, compute: () => T): T {
  let byKey = cache.get(txns);
  if (!byKey) {
    byKey = new Map();
    cache.set(txns, byKey);
  }
  if (!byKey.has(key)) byKey.set(key, compute());
  return byKey.get(key) as T;
}
