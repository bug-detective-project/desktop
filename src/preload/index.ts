/**
 * The only bridge between the renderer and the main process. It exposes a minimal, typed API on
 * window.bugDetective; the renderer has no access to Node, Electron or ipcRenderer itself.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { BugDetectiveApi, Envelope, Snapshot } from '../shared/api.ts';

export class ApiCallError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const envelope = (await ipcRenderer.invoke(`bd:${channel}`, ...args)) as Envelope<T>;
  if (envelope.ok) {
    return envelope.value;
  }
  // Errors cross the context bridge as plain objects, so the code is part of the message too.
  throw new ApiCallError(envelope.error.code, `[${envelope.error.code}] ${envelope.error.message}`);
}

const api: BugDetectiveApi = {
  snapshot: () => call('snapshot'),
  onSnapshot: (listener) => {
    const handler = (_event: unknown, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on('bd:snapshot', handler);
    return () => {
      ipcRenderer.removeListener('bd:snapshot', handler);
    };
  },
  checkPrerequisites: () => call('checkPrerequisites'),
  startDocker: () => call('startDocker'),
  installDevContainers: () => call('installDevContainers'),
  refreshEnvironment: () => call('refreshEnvironment'),
  installEnvironment: (options) => call('installEnvironment', options),
  diskUsage: () => call('diskUsage'),
  nextAssignment: (track) => call('nextAssignment', track),
  switchProject: (project) => call('switchProject', project),
  finishProjectSwitch: () => call('finishProjectSwitch'),
  loadProjects: () => call('loadProjects'),
  move: (ticket, to) => call('move', ticket, to),
  askSenior: (ticket) => call('askSenior', ticket),
  revealSolution: (ticket) => call('revealSolution', ticket),
  acceptReview: (ticket) => call('acceptReview', ticket),
  markInboxRead: (id) => call('markInboxRead', id),
  finishOnboarding: () => call('finishOnboarding'),
  reviewComparison: (ticket) => call('reviewComparison', ticket),
  openReview: (ticket) => call('openReview', ticket),
  closeReview: () => call('closeReview'),
  dismissReviewNotice: () => call('dismissReviewNotice'),
  ticketContent: (ticket, language) => call('ticketContent', ticket, language),
  workspaceStatus: () => call('workspaceStatus'),
  openVSCode: () => call('openVSCode'),
  openAppInBrowser: () => call('openAppInBrowser'),
  startDevServer: () => call('startDevServer'),
  stopDevServer: () => call('stopDevServer'),
  solveBug: (ticket) => call('solveBug', ticket),
  openExternal: (link) => call('openExternal', link),
  updateSettings: (settings) => call('updateSettings', settings),
  exportProgress: () => call('exportProgress'),
  inspectSave: () => call('inspectSave'),
  restoreProgress: (token) => call('restoreProgress', token),
  discardSave: (token) => call('discardSave', token),
  rebuildWorkspace: () => call('rebuildWorkspace'),
  retryDatabaseReset: () => call('retryDatabaseReset'),
  reportRendererError: (message, stack) => call('reportRendererError', message, stack),
  diagnostics: () => call('diagnostics'),
  openLogsFolder: () => call('openLogsFolder'),
  newGame: () => call('newGame'),
  cleanDockerLeftovers: () => call('cleanDockerLeftovers'),
  removeDockerData: () => call('removeDockerData'),
  applyDevCatalog: (settings) => call('applyDevCatalog', settings),
  chooseDevPath: (kind) => call('chooseDevPath', kind),
};

contextBridge.exposeInMainWorld('bugDetective', api);
