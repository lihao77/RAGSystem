export type CircuitState = "closed" | "open" | "half_open";

export interface ExternalCallMetrics {
  key: string;
  state: CircuitState;
  calls: number;
  successes: number;
  failures: number;
  retries: number;
  timeouts: number;
  rejected: number;
  consecutiveFailures: number;
  openedAt: number | null;
}

export interface ExternalCallPolicy {
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export interface ExternalCallOptions<T> extends ExternalCallPolicy {
  key: string;
  operation: (context: { attempt: number; signal: AbortSignal }) => Promise<T>;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (context: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Leaves success accounting and circuit closure to recordSuccess(), for operations that return a stream. */
  deferSuccess?: boolean;
}

export class ExternalCallTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`External call timed out after ${timeoutMs}ms`);
    this.name = "ExternalCallTimeoutError";
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly key: string) {
    super(`External call circuit is open: ${key}`);
    this.name = "CircuitOpenError";
  }
}

export class RetryableHttpError extends Error {
  constructor(readonly status: number, message?: string) {
    super(message?.trim() || `External call failed with HTTP ${status}`);
    this.name = "RetryableHttpError";
  }
}

interface CircuitRecord extends ExternalCallMetrics {
  probeInFlight: boolean;
  failureThreshold: number;
  resetTimeoutMs: number;
}

export class ExternalCallPolicyRegistry {
  private readonly circuits = new Map<string, CircuitRecord>();

  async execute<T>(options: ExternalCallOptions<T>): Promise<T> {
    const circuit = this.getCircuit(options.key, options);
    this.enter(circuit);
    circuit.calls += 1;
    const maxAttempts = clampInteger(options.maxAttempts ?? 1, 1, 10);
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const result = await runWithTimeout(options.operation, attempt, options.timeoutMs, options.signal);
          if (!options.deferSuccess) {
            circuit.successes += 1;
            this.close(circuit);
          }
          return result;
        } catch (error) {
          if (error instanceof ExternalCallTimeoutError) circuit.timeouts += 1;
          if (options.signal?.aborted) throw options.signal.reason ?? error;
          const retryable = (options.shouldRetry ?? isRetryableExternalError)(error);
          if (!retryable || attempt >= maxAttempts) throw error;
          const delayMs = retryDelay(options, attempt);
          circuit.retries += 1;
          options.onRetry?.({ attempt, delayMs, error });
          await delay(delayMs, options.signal);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        if (circuit.state === "half_open") {
          circuit.state = "open";
          circuit.openedAt = Date.now();
        }
        throw error;
      }
      circuit.failures += 1;
      circuit.consecutiveFailures += 1;
      if (circuit.state === "half_open" || circuit.consecutiveFailures >= circuit.failureThreshold) {
        circuit.state = "open";
        circuit.openedAt = Date.now();
      }
      throw error;
    } finally {
      circuit.probeInFlight = false;
    }
  }

  snapshot(key?: string): ExternalCallMetrics[] {
    return [...this.circuits.values()]
      .filter((item) => key === undefined || item.key === key)
      .map(({ probeInFlight: _probe, failureThreshold: _threshold, resetTimeoutMs: _reset, ...item }) => ({ ...item }));
  }

  /** Records a failure that happens after the guarded operation returned, such as a stalled response stream. */
  recordFailure(key: string, error: unknown, policy: ExternalCallPolicy = {}): void {
    const circuit = this.getCircuit(key, policy);
    circuit.failures += 1;
    circuit.consecutiveFailures += 1;
    if (error instanceof ExternalCallTimeoutError) circuit.timeouts += 1;
    if (circuit.state === "half_open" || circuit.consecutiveFailures >= circuit.failureThreshold) {
      circuit.state = "open";
      circuit.openedAt = Date.now();
    }
  }

  recordSuccess(key: string, policy: ExternalCallPolicy = {}): void {
    const circuit = this.getCircuit(key, policy);
    circuit.successes += 1;
    this.close(circuit);
  }

  recordAbort(key: string): void {
    const circuit = this.circuits.get(key);
    if (circuit?.state === "half_open") {
      circuit.state = "open";
      circuit.openedAt = Date.now();
      circuit.probeInFlight = false;
    }
  }

  reset(key?: string): void {
    if (key === undefined) this.circuits.clear();
    else this.circuits.delete(key);
  }

  private getCircuit(key: string, options: ExternalCallPolicy): CircuitRecord {
    let circuit = this.circuits.get(key);
    if (!circuit) {
      circuit = {
        key,
        state: "closed",
        calls: 0,
        successes: 0,
        failures: 0,
        retries: 0,
        timeouts: 0,
        rejected: 0,
        consecutiveFailures: 0,
        openedAt: null,
        probeInFlight: false,
        failureThreshold: clampInteger(options.failureThreshold ?? 5, 1, 100),
        resetTimeoutMs: Math.max(1, options.resetTimeoutMs ?? 30_000),
      };
      this.circuits.set(key, circuit);
    }
    return circuit;
  }

  private enter(circuit: CircuitRecord): void {
    if (circuit.state === "half_open") {
      circuit.rejected += 1;
      throw new CircuitOpenError(circuit.key);
    }
    if (circuit.state !== "open") return;
    if (circuit.openedAt !== null && Date.now() - circuit.openedAt >= circuit.resetTimeoutMs && !circuit.probeInFlight) {
      circuit.state = "half_open";
      circuit.probeInFlight = true;
      return;
    }
    circuit.rejected += 1;
    throw new CircuitOpenError(circuit.key);
  }

  private close(circuit: CircuitRecord): void {
    circuit.state = "closed";
    circuit.consecutiveFailures = 0;
    circuit.openedAt = null;
  }
}

export const externalCallPolicy = new ExternalCallPolicyRegistry();

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function isRetryableExternalError(error: unknown): boolean {
  return error instanceof ExternalCallTimeoutError
    || error instanceof RetryableHttpError
    || (error instanceof TypeError && error.name !== "AbortError");
}

export function providerCallPolicy(provider: Record<string, unknown>): ExternalCallPolicy {
  const timeoutSeconds = positiveNumber(provider.timeout, 60);
  const retries = clampInteger(positiveNumber(provider.retry_attempts, 0), 0, 9);
  return {
    timeoutMs: timeoutSeconds * 1000,
    maxAttempts: retries + 1,
    baseDelayMs: positiveNumber(provider.retry_delay, 1) * 1000,
    backoffFactor: positiveNumber(provider.retry_backoff_factor, 2),
  };
}

async function runWithTimeout<T>(
  operation: ExternalCallOptions<T>["operation"],
  attempt: number,
  timeoutMs = 60_000,
  parentSignal?: AbortSignal,
): Promise<T> {
  const timeout = Math.max(1, timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ExternalCallTimeoutError(timeout));
  }, timeout);
  const abortParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortParent, { once: true });
  if (parentSignal?.aborted) abortParent();
  try {
    return await operation({ attempt, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ExternalCallTimeoutError(timeout);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortParent);
  }
}

function retryDelay(policy: ExternalCallPolicy, attempt: number): number {
  const base = Math.max(0, policy.baseDelayMs ?? 1_000);
  const factor = Math.max(1, policy.backoffFactor ?? 2);
  const maximum = Math.max(base, policy.maxDelayMs ?? 30_000);
  const jitter = Math.min(1, Math.max(0, policy.jitterRatio ?? 0.2));
  const raw = Math.min(maximum, base * factor ** (attempt - 1));
  return Math.round(raw * (1 - jitter + Math.random() * jitter * 2));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
