import { validateResolutionMetadata } from "../judgment/resolution.js";
import type { AdapterCheckpoint } from "./types.js";
import { decodeJudgment } from "../judgment/checkpoint.js";
import { validateJudgmentReferences } from "../delivery/judgment.js";
import { registeredArtifact } from "../delivery/artifacts.js";
import { contracts, type Phase } from "../policy.js";
import { commit, invalid, object } from "../validation.js";

export function decodeJudgmentHistory(value: unknown): AdapterCheckpoint["judgmentHistory"] {
  if (!Array.isArray(value)) invalid("invalid Judge history");
  return value.map((entry) => {
    if (
      !object(entry) ||
      !object(entry.decision) ||
      !object(entry.authorization) ||
      !object(entry.accepted)
    )
      invalid("invalid Judge history");
    const state = decodeJudgment(entry.state);
    if (!state?.report) invalid("historical Judge report is required");
    const decision = entry.decision;
    const phase =
      decision.verdict === "REWORK_IMPLEMENTATION"
        ? "implementation"
        : decision.verdict === "REDEFINE"
          ? "define"
          : decision.verdict === "REVISIT_DESIGN"
            ? "design"
            : null;
    if (
      !phase ||
      decision.phase !== phase ||
      decision.status !== "reopened" ||
      decision.reportId !== state.report.artifact_id ||
      decision.reportDigest !== state.report.digest ||
      decision.planArtifactId !== state.evaluation.planArtifactId ||
      decision.evaluatedCommit !== state.evaluation.evaluatedCommit ||
      JSON.stringify(decision.incrementIds) !== JSON.stringify(state.evaluation.incrementIds) ||
      !Number.isSafeInteger(decision.appliedAt) ||
      Number(decision.appliedAt) < 0 ||
      entry.authorization.artifactId !== decision.planArtifactId ||
      !(entry.authorization.baseCommit === null || commit(entry.authorization.baseCommit))
    )
      invalid("invalid historical Judge decision");
    validateResolutionMetadata(
      decision,
      state.report.verdict,
      state.report.artifact_id,
      Number(decision.appliedAt),
    );
    if (
      object(decision.resolution) &&
      Object.values(state.attempts).some(
        (attempt) =>
          attempt.startedAt > Number((decision.resolution as Record<string, unknown>).confirmedAt),
      )
    )
      invalid("human resolution predates Judgment");
    return structuredClone({ ...entry, state }) as AdapterCheckpoint["judgmentHistory"][number];
  });
}

/** Validate old evaluations against their frozen delivery, never against the latest Plan. */
export function validateJudgmentHistory(checkpoint: AdapterCheckpoint): void {
  const owners = [
    checkpoint.knowledge,
    ...Object.values(checkpoint.implementations).flat(),
    ...Object.values(checkpoint.verifications).flat(),
  ];
  const instances = new Set(owners.map((state) => state.instanceId));
  const attempts = new Set(owners.flatMap((state) => Object.keys(state.attempts)));
  const artifacts = new Set(owners.flatMap((state) => Object.keys(state.artifacts)));
  const judges = [
    ...checkpoint.judgmentHistory.map((entry) => entry.state),
    ...(checkpoint.judgment ? [checkpoint.judgment] : []),
  ];
  for (const state of judges) {
    if (instances.has(state.instanceId)) invalid("duplicate Judge instance identity");
    instances.add(state.instanceId);
    for (const id of Object.keys(state.attempts)) {
      if (attempts.has(id)) invalid("duplicate Judge attempt identity");
      attempts.add(id);
    }
    if (state.report) {
      if (artifacts.has(state.report.artifact_id)) invalid("duplicate Judge artifact identity");
      artifacts.add(state.report.artifact_id);
    }
  }
  for (const entry of checkpoint.judgmentHistory) {
    const ref = entry.decision.resolution;
    if (ref) {
      if (artifacts.has(ref.artifact_id)) invalid("duplicate human resolution identity");
      artifacts.add(ref.artifact_id);
    }
  }
  for (const [index, entry] of checkpoint.judgmentHistory.entries()) {
    const preceding = checkpoint.judgmentHistory.slice(0, index);
    const priorRework = preceding.findLast(
      (candidate) =>
        candidate.decision.planArtifactId === entry.authorization.artifactId &&
        candidate.decision.verdict === "REWORK_IMPLEMENTATION",
    );
    if (
      entry.authorization.reworkReportId !== priorRework?.decision.reportId ||
      (priorRework && entry.authorization.baseCommit !== priorRework.decision.evaluatedCommit) ||
      entry.decision.appliedAt < checkpoint.knowledge.startedAt ||
      Object.values(entry.state.attempts).some(
        (attempt) => attempt.startedAt > entry.decision.appliedAt,
      ) ||
      (preceding.at(-1)?.decision.appliedAt ?? 0) > entry.decision.appliedAt ||
      Object.keys(entry.accepted).length !== Object.keys(contracts).length ||
      Object.entries(entry.accepted).some(
        ([phase, id]) =>
          !contracts[phase as Phase] ||
          checkpoint.knowledge.artifacts[id]?.kind !== contracts[phase as Phase].kind,
      ) ||
      (entry.decision.phase !== "implementation" &&
        !checkpoint.reconciliations.some(
          (source) => source.judgmentArtifactId === entry.decision.reportId,
        ))
    )
      invalid("invalid historical Judge application context");
    const ids = new Set(entry.state.evaluation.artifacts.map((input) => input.artifact_id));
    for (const input of entry.state.evaluation.artifacts) {
      const registered = registeredArtifact(checkpoint, input.artifact_id);
      if (
        registered.digest !== input.digest ||
        registered.path !== input.path ||
        registered.kind !== input.kind
      )
        invalid("historical Judge evidence changed");
    }
    const knowledge = {
      ...checkpoint.knowledge,
      accepted: entry.accepted,
      lifecycle: { status: "completed" as const, artifactId: entry.authorization.artifactId },
    };
    const snapshot: AdapterCheckpoint = {
      ...checkpoint,
      knowledge,
      judgment: entry.state,
      closure: null,
      authorizedPlan: entry.authorization,
      reconciliations: [],
      judgmentHistory: checkpoint.judgmentHistory.slice(0, index),
      implementations: Object.fromEntries(
        Object.entries(checkpoint.implementations).map(([id, history]) => [
          id,
          history.filter(
            (state) =>
              state.lifecycle.status === "completed" && ids.has(state.lifecycle.artifactId),
          ),
        ]),
      ),
      verifications: Object.fromEntries(
        Object.entries(checkpoint.verifications).map(([id, history]) => [
          id,
          history.filter(
            (state) =>
              state.lifecycle.status === "completed" && ids.has(state.lifecycle.artifactId),
          ),
        ]),
      ),
    };
    if (knowledge.artifacts[entry.authorization.artifactId]?.digest !== entry.authorization.digest)
      invalid("historical Judge Plan digest mismatch");
    validateJudgmentReferences(snapshot);
  }
  for (const state of Object.values(checkpoint.implementations).flat()) {
    if (!state.reworkReportId) continue;
    const source = checkpoint.judgmentHistory.find(
      (entry) => entry.decision.reportId === state.reworkReportId,
    );
    if (
      !source ||
      source.decision.verdict !== "REWORK_IMPLEMENTATION" ||
      source.decision.planArtifactId !== state.planArtifactId ||
      !source.decision.incrementIds.includes(state.incrementId) ||
      !state.assignment.inputs.includes(state.reworkReportId) ||
      (source.decision.resolution &&
        !state.assignment.inputs.includes(source.decision.resolution.artifact_id))
    )
      invalid("implementation rework has no applied Judge authorization");
    if (state.startedAt < source.decision.appliedAt)
      invalid("implementation predates its Judge authorization");
  }
  const authorized = checkpoint.authorizedPlan;
  const latest = checkpoint.judgmentHistory.findLast(
    (entry) =>
      entry.decision.planArtifactId === authorized?.artifactId &&
      entry.decision.verdict === "REWORK_IMPLEMENTATION",
  );
  if (
    authorized?.reworkReportId !== latest?.decision.reportId ||
    (latest && authorized?.baseCommit !== latest.decision.evaluatedCommit)
  )
    invalid("invalid Judge delivery authorization");
}
