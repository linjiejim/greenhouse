import type { DatabaseProvider } from '@greenhouse/db';
import type { ToolRegistry } from '../agent.js';
export interface AgentChannel {
  id: string;
  start(ctx: {
    db: DatabaseProvider;
    toolRegistry: ToolRegistry;
  }): Promise<void | (() => void | Promise<void>)> | void | (() => void | Promise<void>);
}
/** Channel lifetimes belong to the host, just like scheduler jobs. */
export async function startChannels(
  channels: readonly AgentChannel[],
  ctx: { db: DatabaseProvider; toolRegistry: ToolRegistry },
) {
  if (new Set(channels.map((channel) => channel.id)).size !== channels.length)
    throw new Error('Duplicate agent channel');
  const stops: Array<() => void | Promise<void>> = [];
  try {
    for (const channel of channels) {
      const stop = await channel.start(ctx);
      if (stop) stops.push(stop);
    }
  } catch (error) {
    for (const stop of stops.reverse()) await stop();
    throw error;
  }
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    for (const stop of [...stops].reverse()) await stop();
  };
}
