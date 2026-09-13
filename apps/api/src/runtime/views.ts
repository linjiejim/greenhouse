/** Runtime database-row → shared wire-contract projections. */

import type {
  RuntimeArtifactRow,
  RuntimeEventRow,
  RuntimeInterruptRow,
  RuntimeRunRow,
  RuntimeStepRow,
  RuntimeToolCallRow,
} from '@greenhouse/db';
import type {
  RuntimeArtifact,
  RuntimeEvent,
  RuntimeInterrupt,
  RuntimeJsonValue,
  RuntimeRun,
  RuntimeStep,
  RuntimeToolCall,
} from '@greenhouse/types/runtime';
import { safeJsonParse } from '@greenhouse/utils/json';

export function runtimePayloadView(raw: string | null): RuntimeJsonValue | null {
  return raw === null ? null : (safeJsonParse(raw, { raw }) as RuntimeJsonValue);
}

export function runtimeRunView(row: RuntimeRunRow): RuntimeRun {
  return { ...row, input: runtimePayloadView(row.input)!, output: runtimePayloadView(row.output) };
}

export function runtimeEventView(row: RuntimeEventRow): RuntimeEvent {
  return { ...row, payload: runtimePayloadView(row.payload)! };
}

export function runtimeStepView(row: RuntimeStepRow): RuntimeStep {
  return { ...row, input: runtimePayloadView(row.input)!, output: runtimePayloadView(row.output) };
}

export function runtimeToolCallView(row: RuntimeToolCallRow): RuntimeToolCall {
  return { ...row, input: runtimePayloadView(row.input)!, output: runtimePayloadView(row.output) };
}

export function runtimeArtifactView(row: RuntimeArtifactRow): RuntimeArtifact {
  return row;
}

export function runtimeInterruptView(row: RuntimeInterruptRow): RuntimeInterrupt {
  return { ...row, payload: runtimePayloadView(row.payload)!, decision: runtimePayloadView(row.decision) };
}
