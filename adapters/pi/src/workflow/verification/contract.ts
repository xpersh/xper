export interface VerificationTestResult {
  command: string;
  exitCode: number;
  outputPath: string;
}

export interface VerificationFinding {
  outcome: "passed" | "failed";
  evidence: string;
  paths: string[];
}

export type KnowledgeFeedbackReason = "ambiguous_criteria" | "infeasible_design";

export interface VerificationRejection {
  cause: string;
  evidence: string;
  paths: string[];
  /** Optional for backwards-compatible verification-v1 artifacts. */
  knowledgeFeedback?: { reason: KnowledgeFeedbackReason } | null;
}

export interface VerificationResult {
  schemaVersion: 1;
  inputs: string[];
  output: {
    kind: "verification_result";
    assignmentId: string;
    incrementId: string;
    implementationArtifactId: string;
    baseCommit: string;
    evaluatedCommit: string;
    verdict: "verified" | "rejected";
    tests: VerificationTestResult[];
    criteria: Array<VerificationFinding & { criterionId: string }>;
    review: {
      regressions: VerificationFinding;
      scope: VerificationFinding;
      simplicity: VerificationFinding;
    };
    rejection: null | VerificationRejection;
  };
}
