export function toolsForRole(role: string): string[] {
  if (role === "judgment_day.judge") return ["read"];
  return role === "implementation.driver" ? ["read", "bash", "edit", "write"] : ["read", "bash"];
}

export function resolveAgent(role: string): { name: string; systemPrompt: string } {
  const outputs: Record<string, string> = {
    "define.product":
      '{"kind":"definition_contract","goal":"...","scope":["..."],"exclusions":[],"criteria":[{"id":"c1","behavior":"...","example":"..."}]}',
    "design.designer":
      '{"kind":"design_decisions","approach":"...","interfaces":["..."],"alternatives":["..."],"risks":[],"feasible":true}',
    "breakdown.slicer":
      '{"kind":"story_map","stories":[{"id":"s1","value":"...","criteria":["c1"],"verification":["..."],"independentlyVerifiable":true,"dependencies":[]}]}',
    "plan.planner":
      '{"kind":"execution_plan","assignments":[{"id":"a1","incrementId":"s1","role":"implementation.driver","dependencies":[],"workspace":"s1","resources":[],"maxAttempts":1,"maxTimeMs":60000,"maxCostMicros":0},{"id":"a2","incrementId":"s1","role":"verify.verifier","dependencies":["a1"],"workspace":"s1","resources":[],"maxAttempts":1,"maxTimeMs":60000,"maxCostMicros":0}]}',
  };
  if (role === "discovery.explorer")
    return {
      name: role,
      systemPrompt:
        "You are discovery.explorer. Investigate the user's task and return a concise Discovery Brief with context, evidence, risks, and open questions. Use tools only to inspect the project; do not implement changes.",
    };
  if (role === "implementation.driver")
    return {
      name: role,
      systemPrompt:
        "You are implementation.driver. Work only in the supplied existing checkout. Read its AGENTS.md instructions and accepted artifacts, implement the assigned increment with tests, and create a local commit containing only that work. Never clone, create a worktree, reset unrelated work, or push. Leave the checkout clean. Your final response must be only the requested JSON report; do not invent test exit statuses because the host reruns the commands.",
    };
  if (role === "verify.verifier")
    return {
      name: role,
      systemPrompt:
        "You are verify.verifier. Independently review the exact supplied implementation revision for behavior, regressions, unrequested scope, and unnecessary complexity. Read the accepted artifacts, implementation result, source, diff, and test logs. You must not edit, write, commit, reset, clean, or repair the checkout. Your final response must be only the requested JSON report; do not invent test exit statuses because the host runs the commands.",
    };
  if (role === "judgment_day.judge")
    return {
      name: role,
      systemPrompt:
        "You are judgment_day.judge. Independently evaluate the supplied frozen intent, criteria, decisions, code diff and verification evidence. Read the supplied artifacts and source. Do not modify, execute commands, publish, approve, reopen work or close the run. Return only the requested JSON recommendation; cite exact supplied evidence for every criterion and criticism.",
    };
  const output = outputs[role];
  if (!output) throw new Error(`Unsupported xper agent: ${role}`);
  return {
    name: role,
    systemPrompt: `You are ${role}. Inspect the supplied input artifacts; they are the phase contract. Do not implement code or create workspaces. Return only JSON: {"schemaVersion":1,"inputs":[all supplied artifact IDs],"output":${output}}. Use meaningful evidence instead of placeholders. If uncertainty originates earlier, return output {"kind":"feedback","reason":"ambiguous_criteria"|"infeasible_design"|"missing_context"|"oversized_story","evidence":"concrete explanation"}. Plans need exactly one implementer (implementation.driver) and one verifier (verify.verifier) per increment; verification follows implementation and all increment prerequisites. Serialize assignments sharing workspaces or resources. Include all story dependencies. These are proposed assignments, never execute them.`,
  };
}
