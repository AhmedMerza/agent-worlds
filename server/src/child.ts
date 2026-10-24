import { execFile as rawExecFile, spawn as rawSpawn, spawnSync, type ChildProcess } from 'node:child_process';

/** Child stdio uses Socket/Pipe objects whose errors are not forwarded to the ChildProcess. */
export function containChildStdio<T extends ChildProcess>(child: T): T {
  for (const [name, stream] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]] as const) {
    stream?.on('error', (error: NodeJS.ErrnoException) => {
      if (name !== 'stdin' || !['EBADF', 'ECONNRESET', 'EPIPE'].includes(error.code ?? '')) console.error(`[agent-worlds] child ${name} error`, error);
      if (name !== 'stdin' && !child.killed) child.kill();
    });
  }
  return child;
}

export const execFile = ((...args: unknown[]) => containChildStdio(Reflect.apply(rawExecFile, undefined, args))) as typeof rawExecFile;
export const spawn = ((...args: unknown[]) => containChildStdio(Reflect.apply(rawSpawn, undefined, args))) as typeof rawSpawn;
export { spawnSync };
export type { ChildProcess };
