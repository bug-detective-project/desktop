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

/** The forwarder: a small TCP relay, and the only container on both networks. */
export const FORWARDER_LIMITS: ContainerLimits = { memory: '128m', pids: 64 };

const DEFAULT_LIMITS = { workspace: WORKSPACE_LIMITS, qa: QA_LIMITS, forwarder: FORWARDER_LIMITS } as const;

/**
 * The environment variables that override the defaults, read when a container is created (so a
 * change applies to the next container, with no new build): a memory size as docker takes it
 * (3g, 2048m, 512m) and a positive number of pids. An invalid value keeps the default.
 */
export const LIMIT_ENV = {
  workspace: { memory: 'BUGDETECTIVE_WORKSPACE_MEMORY', pids: 'BUGDETECTIVE_WORKSPACE_PIDS' },
  qa: { memory: 'BUGDETECTIVE_QA_MEMORY', pids: 'BUGDETECTIVE_QA_PIDS' },
  forwarder: { memory: 'BUGDETECTIVE_FORWARDER_MEMORY', pids: 'BUGDETECTIVE_FORWARDER_PIDS' },
} as const;

const MEMORY = /^[1-9]\d*[kmg]?b?$/i;

export function containerLimits(kind: keyof typeof LIMIT_ENV, env: Record<string, string | undefined> = process.env): ContainerLimits {
  const defaults = DEFAULT_LIMITS[kind];
  const memory = env[LIMIT_ENV[kind].memory]?.trim();
  const pids = env[LIMIT_ENV[kind].pids]?.trim();
  return {
    memory: memory && MEMORY.test(memory) ? memory.toLowerCase() : defaults.memory,
    pids: pids && /^[1-9]\d*$/.test(pids) ? Number(pids) : defaults.pids,
  };
}

/** No capability at all, and no way to gain one (setuid binaries, file capabilities). */
export const HARDENING_ARGS: readonly string[] = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

/** The `docker run` arguments of the limits and the hardening. No --cpus: the scheduler shares what there is. */
export function limitArgs(limits: ContainerLimits): string[] {
  return ['--memory', limits.memory, '--pids-limit', String(limits.pids), ...HARDENING_ARGS];
}
