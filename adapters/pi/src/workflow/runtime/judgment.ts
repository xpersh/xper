import { admit } from "../policy.js";
import type { AdapterCheckpoint } from "../checkpoint/types.js";
import { judgmentChange } from "../checkpoint/update.js";
import { runBudget } from "../delivery/budget.js";
import { satisfiedAssignmentArtifacts } from "../delivery/frontier.js";
import { judgmentEvaluation } from "../delivery/judgment.js";
import { selectNextImplementationHandoff, validateLinks } from "../delivery/plan.js";
import { transitionJudgment } from "../judgment/machine.js";
import type { FinishAttempt, JudgmentEvaluation } from "../types.js";
import { invalid } from "../validation.js";
import { readKnowledgeDocuments } from "./handoff.js";
import type { WorkflowEffects } from "./ports.js";

export async function checkEvaluation(evaluation: JudgmentEvaluation, effects: WorkflowEffects) {
  for (const input of [...evaluation.artifacts, ...evaluation.logs]) {
    if ((await effects.readArtifact(input.path)).digest !== input.digest)
      invalid("Judgment evidence changed since evaluation was frozen");
  }
  const workspace = await effects.inspectWorkspace(effects.cwd);
  if (!workspace.clean || workspace.head !== evaluation.evaluatedCommit)
    invalid("Judgment requires the clean evaluated revision");
}
export async function prepareJudgmentAssignment(
  checkpoint: AdapterCheckpoint,
  assignmentId: string | undefined,
  fallbackModel: string | undefined,
  effects: WorkflowEffects,
) {
  const documents = await readKnowledgeDocuments(checkpoint, effects.readArtifact);
  const plan = documents.plan;
  if (!plan) invalid("sealed Plan is unavailable");
  const satisfied = satisfiedAssignmentArtifacts(checkpoint);
  const budget = runBudget(checkpoint, effects.now());
  try {
    validateLinks(plan.output, documents, budget, new Set(satisfied.keys()));
    if (
      selectNextImplementationHandoff(
        plan.output,
        documents,
        checkpoint.knowledge.routing,
        satisfied,
      ).status !== "complete"
    )
      return null;
  } catch (error) {
    invalid(
      `sealed Plan is unsupported; replan before delivery (${error instanceof Error ? error.message : "invalid handoff"})`,
    );
  }
  const previous = checkpoint.judgment;
  if (previous?.report) invalid("Judge recommendation is already recorded and remains unapplied");
  const selection = previous
    ? previous.selection
    : (checkpoint.knowledge.routing?.routes["judgment_day.judge"]?.[0] ?? null);
  if (!previous && checkpoint.knowledge.routing && !selection)
    invalid("active profile has no judgment_day.judge route");
  const model = previous ? previous.model : selection ? null : (fallbackModel ?? null);
  if (!selection && !model)
    invalid("Judgment requires the active Pi model to freeze its selection");
  admit(checkpoint.knowledge.policy, budget, 0);
  const evaluation = previous?.evaluation ?? { ...judgmentEvaluation(checkpoint), logs: [] };
  if (!previous) {
    const logs = new Map<string, string>();
    for (const artifact of evaluation.artifacts) {
      const evidence = await effects.readArtifact(artifact.path);
      if (evidence.digest !== artifact.digest) invalid("Judgment input digest mismatch");
      if (artifact.kind === "implementation_result" || artifact.kind === "verification_result")
        for (const test of JSON.parse(evidence.content).output.tests as Array<{
          outputPath: string;
        }>)
          logs.set(test.outputPath, (await effects.readArtifact(test.outputPath)).digest);
    }
    evaluation.logs = [...logs].map(([path, digest]) => ({ path, digest }));
  }
  const seed = previous ?? {
    runId: checkpoint.knowledge.run_id,
    instanceId: effects.id(),
    assignmentId: effects.id(),
    evaluation,
    selection,
    model,
  };
  await checkEvaluation(evaluation, effects);
  const now = effects.now();
  return {
    change: judgmentChange(
      checkpoint,
      transitionJudgment(
        previous,
        {
          type: "assignment.start",
          seed,
          attemptId: effects.id(),
          ...(assignmentId ? { assignmentId } : {}),
          budget: runBudget(checkpoint, now),
          policy: checkpoint.knowledge.policy,
        },
        now,
      ),
    ),
    now,
  };
}
export async function prepareJudgmentSettlement(
  checkpoint: AdapterCheckpoint,
  result: FinishAttempt,
  effects: WorkflowEffects,
) {
  let evidence: Awaited<ReturnType<WorkflowEffects["readArtifact"]>> | undefined;
  if (
    result.outcome === "succeeded" &&
    checkpoint.judgment?.attempts[result.attemptId]?.outcome === null
  ) {
    try {
      if (!checkpoint.judgment) invalid("Judgment evaluation is unavailable");
      await checkEvaluation(checkpoint.judgment.evaluation, effects);
      evidence = await effects.readArtifact(result.artifactPath);
    } catch (error) {
      invalid(error instanceof Error ? error.message : "invalid Judgment evidence");
    }
  }
  const now = effects.now();
  return {
    change: judgmentChange(
      checkpoint,
      transitionJudgment(
        checkpoint.judgment,
        {
          type: "attempt.finish",
          result,
          artifactId: effects.id(),
          ...(evidence ? { evidence } : {}),
        },
        now,
      ),
    ),
    now,
  };
}
