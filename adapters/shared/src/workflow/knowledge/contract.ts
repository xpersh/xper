export interface Criterion {
  id: string;
  behavior: string;
  example: string;
}

export interface Story {
  id: string;
  value: string;
  criteria: string[];
  verification: string[];
  independentlyVerifiable: boolean;
  dependencies: string[];
}

export interface PlannedAssignment {
  id: string;
  incrementId: string;
  role: string;
  dependencies: string[];
  workspace: string;
  resources: string[];
  maxAttempts: number;
  maxTimeMs: number;
  maxCostMicros: number;
}

export type Output =
  | {
      kind: "definition_contract";
      goal: string;
      scope: string[];
      exclusions: string[];
      criteria: Criterion[];
    }
  | {
      kind: "design_decisions";
      approach: string;
      interfaces: string[];
      alternatives: string[];
      risks: string[];
      feasible: boolean;
    }
  | { kind: "story_map"; stories: Story[] }
  | { kind: "execution_plan"; assignments: PlannedAssignment[] }
  | { kind: "feedback"; reason: string; evidence: string };

export interface Document {
  schemaVersion: 1;
  inputs: string[];
  output: Output;
}

export interface Node {
  id: string;
  dependencies: string[];
  workspace?: string;
  resources?: string[];
}
