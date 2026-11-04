/**
 * Resource limits and hardening of every container the app runs. The player's code (the
 * workspace, the QA runs) is untrusted: a loop or a leak must not take the computer down, and no
 * process inside may gain capabilities. The QA helpers (copying files) get the same limits.
 */
export interface ContainerLimits {
  /** docker --memory (the kernel kills the biggest process when it is exceeded: exit code 137, OOMKilled). */
  memory: string;
  /** docker --pids-limit: a fork bomb stops at this many processes. */
  pids: number;
}

/** The workspace: the dev server, VS Code's server and the player's terminals. */
export const WORKSPACE_LIMITS: ContainerLimits = { memory: '3g', pids: 1024 };
/** A QA run or the dependency preparation: the project's tests, Vite, Chromium. */
export const QA_LIMITS: ContainerLimits = { memory: '2g', pids: 512 };

/** No capability at all, and no way to gain one (setuid binaries, file capabilities). */
export const HARDENING_ARGS: readonly string[] = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

/** The `docker run` arguments of the limits and the hardening. No --cpus: the scheduler shares what there is. */
export function limitArgs(limits: ContainerLimits): string[] {
  return ['--memory', limits.memory, '--pids-limit', String(limits.pids), ...HARDENING_ARGS];
}
