export interface CommandExecutionPort {
  buildCommandClassification: (...args: any[]) => any;
  getExternalCandidates: (...args: any[]) => string[];
  prepareExecution: (...args: any[]) => any;
  executePlan: (...args: any[]) => any;
}

export interface WorkspaceSearchPort {
  glob: (...args: any[]) => any;
  grep: (...args: any[]) => any;
  webFetch: (...args: any[]) => any;
  todoWrite: (...args: any[]) => any;
}

export interface CodeExecutionPort {
  executeCode: (...args: any[]) => any;
}
