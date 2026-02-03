import {
  _resetCache,
  clearCache,
  getCache,
  purgeOutdatedEntries,
  readCacheEntry,
  setCacheExpiryDuration,
  storeCacheEntry,
  useCache,
} from './cache.js';

const factory = jest.fn(() => ({ fresh: true }));
let NOW;
Date.now = () => NOW;

describe('cache utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setCacheExpiryDuration(1000);
  });

  describe('cache API is available', () => {
    beforeEach(async () => {
      // clear all cache entries
      NOW = 50000;
      await purgeOutdatedEntries();
      // set start time
      NOW = 10000;
    });
    describe('useCache', () => {
      describe('when no cache entry is present', () => {
        let result;
        beforeEach(async () => {
          result = await useCache(factory, 'test', 'entry', '01');
        });
        it('runs the factory function', () => {
          expect(factory).toHaveBeenCalledTimes(1);
        });
        it('returns the produced object', () => {
          expect(result).toEqual({ fresh: true });
        });
      });
      describe('when an expired cache entry is present', () => {
        let result;
        beforeEach(async () => {
          await storeCacheEntry({ old: true }, 'test', 'entry', '02');
          NOW = 12000;
          result = await useCache(factory, 'test', 'entry', '02');
        });
        it('runs the factory function', () => {
          expect(factory).toHaveBeenCalledTimes(1);
        });
        it('returns the produced object', () => {
          expect(result).toEqual({ fresh: true });
        });
      });
      describe('when a valid cache entry is present', () => {
        let result;
        beforeEach(async () => {
          await storeCacheEntry({ old: true }, 'test', 'entry', '03');
          NOW = 10800;
          result = await useCache(factory, 'test', 'entry', '03');
        });
        it('does not run the factory function', () => {
          expect(factory).not.toHaveBeenCalled();
        });
        it('returns the cached object', () => {
          expect(result).toEqual({ old: true });
        });
      });
      describe('when no cache entry is present but a similar task is already running', () => {
        let result, longTask, produced;
        beforeEach(async () => {
          produced = { long: Math.random() };
          longTask = jest.fn(
            () =>
              new Promise((resolve) => {
                setTimeout(() => {
                  resolve(produced);
                }, 10);
              })
          );
          useCache(longTask, 'test', 'entry', '04');
          result = await useCache(longTask, 'test', 'entry', '04');
        });
        it('does not run the factory function again', () => {
          expect(longTask).toHaveBeenCalledTimes(1);
        });
        it('returns the object from the existing run', () => {
          expect(result).toBe(produced);
        });
      });
      describe('when an expired cache entry is present (as well as unrelated entries) and a new cache entry is set', () => {
        beforeEach(async () => {
          await storeCacheEntry({ old: true }, 'test', 'entry', '04');
          NOW = 11200;
          await storeCacheEntry({ unrelated: true }, 'unrelated');
          await useCache(factory, 'test', 'entry', '05');
        });
        it('deletes the expired cache entry', async () => {
          await expect(
            readCacheEntry('test', 'entry', '04')
          ).resolves.toBeNull();
        });
        it('preserves unrelated entry', async () => {
          await expect(readCacheEntry('unrelated')).resolves.toEqual({
            unrelated: true,
          });
        });
      });
      describe('when the factory function fails (rejects)', () => {
        let failingFactory;
        let successFactory;

        beforeEach(() => {
          failingFactory = jest.fn(() => Promise.reject(new Error('Task Failed')));
          successFactory = jest.fn(() => Promise.resolve({ success: true }));
        });

        it('propagates the error to the caller', async () => {
          await expect(
            useCache(failingFactory, 'test', 'fail-check', '01')
          ).rejects.toThrow('Task Failed');
        });

        it('removes the failed promise from the internal map allowing retries', async () => {
          // 1. First attempt fails
          // We must catch the error here so the test continues to step 2
          await expect(
            useCache(failingFactory, 'test', 'retry-check', '01')
          ).rejects.toThrow('Task Failed');

          // 2. Second attempt with the SAME keys should run a fresh factory
          // If the bug exists, the rejected promise would still be in the map,
          // causing this line to fail (it would return the old rejection)
          // and successFactory would never be called.
          const result = await useCache(successFactory, 'test', 'retry-check', '01');

          expect(result).toEqual({ success: true });
          expect(successFactory).toHaveBeenCalledTimes(1);
        });

        it('handles simultaneous failures gracefully', async () => {
          // Simulate two callers waiting on the same failing task
          const call1 = useCache(failingFactory, 'test', 'concurrent-fail');
          const call2 = useCache(failingFactory, 'test', 'concurrent-fail');

          await expect(call1).rejects.toThrow('Task Failed');
          await expect(call2).rejects.toThrow('Task Failed');

          expect(failingFactory).toHaveBeenCalledTimes(1); // Should have been deduplicated

          // Verify we can try again immediately
          const result = await useCache(successFactory, 'test', 'concurrent-fail');
          expect(result).toEqual({ success: true });
        });
      });
      describe('when a task fails', () => {
        let failingTask;
        beforeEach(async () => {
          failingTask = jest.fn(() => Promise.reject(new Error('fail')));
          await useCache(failingTask, 'test', 'fail').catch(() => {});
        });
        it('removes the task from the map so it can be retried', async () => {
          const successTask = jest.fn(() => Promise.resolve({ success: true }));
          const result = await useCache(successTask, 'test', 'fail');
          expect(result).toEqual({ success: true });
          expect(successTask).toHaveBeenCalledTimes(1);
        });
      });
    });
    describe('clearCache', () => {
      let result;
      beforeEach(async () => {
        await storeCacheEntry({ old: true }, 'test', 'entry', '03');
        NOW = 10800;
        await clearCache();
        result = await useCache(factory, 'test', 'entry', '03');
      });
      it('do not use the cached function object', () => {
        expect(factory).toHaveBeenCalled();
        expect(result).toEqual({ fresh: true });
      });
      it('clears in-progress tasks', async () => {
        const longTask = jest.fn(
          () => new Promise((resolve) => setTimeout(() => resolve('done'), 100))
        );
        useCache(longTask, 'test', 'inprogress');
        // wait for the task to be started
        await new Promise((resolve) => setTimeout(resolve, 10));
        await clearCache();
        useCache(longTask, 'test', 'inprogress');
        // wait for the second task to be started
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(longTask).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('when the Cache API is not available', () => {
    let result;
    let originalCache;
    beforeEach(async () => {
      _resetCache();
      originalCache = globalThis.caches;
      delete globalThis.caches;
      await storeCacheEntry({ old: true }, 'test', 'entry', '06');
      result = await useCache(factory, 'test', 'entry', '06');
    });
    afterEach(() => {
      globalThis.caches = originalCache;
    });
    it('runs the factory function', () => {
      expect(factory).toHaveBeenCalledTimes(1);
    });
    it('does not use cache, does not fail', () => {
      expect(result).toEqual({ fresh: true });
    });
  });

  describe('when the Cache API is available but blocked for security reasons', () => {
    let result;
    let originalFn;
    beforeEach(async () => {
      _resetCache();
      originalFn = globalThis.caches.open;
      globalThis.caches.open = () => Promise.reject(new Error('not allowed'));
      await storeCacheEntry({ old: true }, 'test', 'entry', '07');
      result = await useCache(factory, 'test', 'entry', '07');
    });
    afterEach(() => {
      globalThis.caches.open = originalFn;
    });
    it('runs the factory function', () => {
      expect(factory).toHaveBeenCalledTimes(1);
    });
    it('does not use cache, does not fail', () => {
      expect(result).toEqual({ fresh: true });
    });
  });

  describe('when the Cache API is available but fails on put()', () => {
    let result;
    beforeEach(async () => {
      _resetCache();
      const cache = await getCache();
      cache.put = () => Promise.reject(new Error('something went wrong'));
      await storeCacheEntry({ old: true }, 'test', 'entry', '08');
      await storeCacheEntry({ old: true }, 'test', 'entry', '09');
      await storeCacheEntry({ old: true }, 'test', 'entry', '10');
      result = await useCache(factory, 'test', 'entry', '08');
      result = await useCache(factory, 'test', 'entry', '09');
      result = await useCache(factory, 'test', 'entry', '10');
    });
    it('runs the factory function', () => {
      expect(factory).toHaveBeenCalledTimes(3);
    });
    it('does not use cache, does not fail', () => {
      expect(result).toEqual({ fresh: true });
    });
  });
});
