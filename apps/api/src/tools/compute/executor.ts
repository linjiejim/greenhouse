/**
 * ComputeExecutor — isolated-vm V8 sandbox for LLM-generated code execution.
 *
 * Designed for precise data analysis & calculations. The LLM writes code,
 * passes in data, and gets deterministic results back — no network, no FS,
 * no secrets.
 *
 * Security model (stricter than custom tools):
 *   - Memory: 64MB heap limit
 *   - Timeout: 15s execution limit
 *   - Network: completely disabled (no fetch injection)
 *   - Filesystem: completely disabled (isolated-vm has no fs/require)
 *   - Secrets: none
 *   - Output: 256KB max
 */

import ivm from 'isolated-vm';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

// ─── Types ───────────────────────────────────────────────

export interface ComputeConfig {
  /** V8 isolate heap limit in MB. Default: 64 */
  memoryMB?: number;
  /** Script execution timeout in ms. Default: 15000 */
  timeoutMs?: number;
  /** Max output size in bytes. Default: 256KB */
  maxOutputBytes?: number;
}

export interface ComputeResult {
  success: boolean;
  /** The value returned by the user script's `compute(data)` function. */
  result: unknown;
  /** Console.log output captured from the sandbox. */
  logs: string[];
  /** Error message if execution failed. */
  error?: string;
  /** Wall-clock execution duration in ms. */
  duration_ms: number;
}

// ─── Defaults ────────────────────────────────────────────

const DEFAULT_MEMORY_MB = 64;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024; // 256KB
const MAX_LOG_ENTRIES = 100;
const MAX_LOG_LINE_LENGTH = 2000;

// ─── Executor ────────────────────────────────────────────

/**
 * Execute LLM-generated JavaScript code in an isolated V8 sandbox.
 *
 * The user script must define a `compute(data)` function (sync or async)
 * that receives the input data and returns a JSON-serializable result.
 *
 * Example user code:
 * ```js
 * function compute(data) {
 *   const total = data.items.reduce((sum, i) => sum + i.amount, 0);
 *   return { total, count: data.items.length, avg: total / data.items.length };
 * }
 * ```
 */
export async function executeCompute(code: string, data: unknown, config?: ComputeConfig): Promise<ComputeResult> {
  const memoryMB = config?.memoryMB ?? DEFAULT_MEMORY_MB;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const logs: string[] = [];
  let isolate: ivm.Isolate | null = null;

  const start = Date.now();

  try {
    // 1. Create isolate with memory limit
    isolate = new ivm.Isolate({ memoryLimit: memoryMB });
    const context = await isolate.createContext();
    const jail = context.global;

    // 2. Inject console.log
    await jail.set(
      '__log',
      new ivm.Reference((msg: string) => {
        if (logs.length < MAX_LOG_ENTRIES) {
          logs.push(msg.length > MAX_LOG_LINE_LENGTH ? msg.slice(0, MAX_LOG_LINE_LENGTH) + '…' : msg);
        }
      }),
    );

    // 3. Inject input data (deep copy into isolate)
    await jail.set('__inputData', new ivm.ExternalCopy(data).copyInto());

    // 4. Wrap user code
    //    - Provide console.log polyfill
    //    - Call user's compute() function
    //    - Return JSON-serialized result
    const wrappedCode = `
      const console = {
        log: (...args) => __log.applySync(undefined, [args.map(a => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return String(a); }
        }).join(' ')]),
        warn: (...args) => __log.applySync(undefined, ['[WARN] ' + args.map(a => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return String(a); }
        }).join(' ')]),
        error: (...args) => __log.applySync(undefined, ['[ERROR] ' + args.map(a => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return String(a); }
        }).join(' ')]),
      };

      // User code
      ${code}

      // Execute entry point
      (async () => {
        if (typeof compute !== 'function') {
          throw new Error('Script must define a compute(data) function');
        }
        const result = await compute(__inputData);
        return JSON.stringify(result);
      })();
    `;

    // 5. Compile & execute
    const script = await isolate.compileScript(wrappedCode);
    const resultStr = await script.run(context, {
      timeout: timeoutMs,
      promise: true,
    });

    const duration_ms = Date.now() - start;

    // 6. Parse & validate output size
    if (typeof resultStr !== 'string') {
      return {
        success: false,
        result: null,
        logs,
        error: 'compute() must return a JSON-serializable value',
        duration_ms,
      };
    }

    if (resultStr.length > maxOutputBytes) {
      return {
        success: false,
        result: null,
        logs,
        error: `Output exceeds ${Math.round(maxOutputBytes / 1024)}KB limit (got ${Math.round(resultStr.length / 1024)}KB). Return less data or aggregate results.`,
        duration_ms,
      };
    }

    const result = JSON.parse(resultStr);

    return { success: true, result, logs, duration_ms };
  } catch (err) {
    const duration_ms = Date.now() - start;
    const message = toErrorMessage(err);

    // Classify error for better LLM feedback
    let error: string;
    if (message.includes('Script execution timed out')) {
      error = `Execution timed out after ${timeoutMs}ms. Simplify the code or reduce data size.`;
    } else if (message.includes('Isolate was disposed') || message.includes('out of memory')) {
      error = `Out of memory (limit: ${memoryMB}MB). Reduce data size or avoid large intermediate arrays.`;
    } else {
      error = message;
    }

    logger.warn(`[Compute] Execution failed: ${error}`);
    return { success: false, result: null, logs, error, duration_ms };
  } finally {
    if (isolate) {
      try {
        isolate.dispose();
      } catch {
        // Already disposed, ignore
      }
    }
  }
}
