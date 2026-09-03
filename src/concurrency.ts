/**
 * 每 API key 的并发闸（host 侧，无依赖）。
 *
 * SenseNova 渠道对 API key 存在并发限制，瞬时并发超限会触发 429。本模块在
 * provider 侧把同一 key 的并发生成请求压到配置上限内：达到上限的新请求排队
 * 等待（FIFO），前序请求释放额度后按序开始，而不是立即失败。429 语义不变，
 * 仍由宿主重试层退避后原 key 重试，此闸只是从源头抑制并发超限。
 *
 * 队列与在途计数均以 key 为键；key 条目在排空后惰性删除。本模块刻意不依赖
 * cordis，node 测试可直接驱动。
 *
 * @module dsh-sensenova-provider/concurrency
 */

export type Release = () => void;

/** 把配置的并发上限归一化为正整数：非整数、负数或无法解析一律回退 1。 */
export function normalizeConcurrencyLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

/** 排队/等待期间中止时抛出的取消错误（不占额度）。 */
export function concurrencyAbortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

interface QueueEntry {
  signal: AbortSignal | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

interface KeyState {
  inFlight: number;
  queue: QueueEntry[];
}

/**
 * 按 key 隔离的并发闸：`acquire(key, limit, signal?)` 在额度允许时立即返回
 * `release()`；达到上限时按 FIFO 排队，前序释放后唤起队首。排队期间 signal
 * 中止则 reject 取消错误且不占额度。release 幂等，排空后惰性删除 key 条目。
 */
export class KeyedConcurrencyGate {
  private readonly states = new Map<string, KeyState>();

  acquire(key: string, limit: unknown, signal?: AbortSignal): Promise<Release> {
    const capacity = normalizeConcurrencyLimit(limit);
    if (signal?.aborted) return Promise.reject(concurrencyAbortError());
    let state = this.states.get(key);
    if (state === undefined) {
      state = { inFlight: 0, queue: [] };
      this.states.set(key, state);
    }
    if (state.inFlight < capacity) {
      state.inFlight += 1;
      return Promise.resolve(this.releaseOf(key, state));
    }
    return new Promise<Release>((resolve, reject) => {
      const entry: QueueEntry = {
        signal,
        resolve: () => {
          if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
          state.inFlight += 1;
          resolve(this.releaseOf(key, state));
        },
        reject: (error) => {
          if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
          reject(error);
        },
        onAbort: () => {
          const index = state.queue.indexOf(entry);
          if (index >= 0) state.queue.splice(index, 1);
          reject(concurrencyAbortError());
        },
      };
      state.queue.push(entry);
      if (signal !== undefined) {
        if (signal.aborted) entry.onAbort();
        else signal.addEventListener('abort', entry.onAbort, { once: true });
      }
    });
  }

  private releaseOf(key: string, state: KeyState): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.inFlight -= 1;
      const next = state.queue.shift();
      if (next !== undefined) {
        next.resolve();
      } else if (state.inFlight === 0) {
        this.states.delete(key);
      }
    };
  }
}