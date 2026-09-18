export interface TestWorkspace {
  root: string;
  project: string;
  cleanup(): Promise<void>;
}

export function createTestWorkspace(prefix?: string): Promise<TestWorkspace>;
