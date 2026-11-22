// The small surface a workflow's `agent`, `task` and `setting` steps need from the Advance panel.
//
// The panel registers itself here at activation instead of being imported by the runner, so the
// runner -> panel -> runner import cycle that would otherwise exist is broken.

export interface AdvanceBridge {
  /** Send a turn to the Advance chat, queued until the engine is idle. */
  submitPrompt(text: string): void;
  /** Queue a task and start its turn, queued until the engine is idle. */
  submitTask(title: string, description: string, prompt: string): void;
  /** Store a credential in VS Code's secret storage. */
  storeSetting(key: string, value: string): Promise<void>;
}

let current: AdvanceBridge | undefined;

export function setAdvanceBridge(bridge: AdvanceBridge | undefined): void {
  current = bridge;
}

export function advanceBridge(): AdvanceBridge | undefined {
  return current;
}
