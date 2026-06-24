/**
 * 异步队列：handle.events 事件的承载（设计稿 §6 推流）。
 *
 * push 侧（dispatcher）同步入队，消费侧 async iterator 依次取出。run 结束后 close，
 * iterator 自然结束。背压不在本期考虑（单 run 事件量有限），队列无界。
 */

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private closed = false;
  private pending: Array<(value: IteratorResult<T>) => void> = [];

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.pending.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.pending.length > 0) {
      const waiter = this.pending.shift()!;
      waiter({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.pending.push(resolve);
        });
      },
    };
  }
}
