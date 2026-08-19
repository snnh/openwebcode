import type { FastifyInstance } from "fastify";
import { errorMessage } from "../error-utils.js";
import type { RouteContext } from "./route-context.js";

export function registerEvalRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { dependencies } = ctx;


  // ---- 评测 harness（0.5.0 Phase 3a）----
  app.get("/api/eval/tasks", async (_request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    return { tasks: dependencies.evalEvaluator.listTasks() };
  });
  app.post<{ Body: { taskIds?: string[] } }>("/api/eval/run", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    const taskIds = Array.isArray(request.body?.taskIds) ? request.body.taskIds.filter((id): id is string => typeof id === "string") : undefined;
    try {
      const report = await dependencies.evalEvaluator.runTasks(taskIds);
      return reply.code(200).send(report);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.get<{ Params: { runId: string } }>("/api/eval/runs/:runId", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    const report = await dependencies.evalEvaluator.getRun(request.params.runId);
    if (!report) return reply.code(404).send({ error: "Run not found" });
    return report;
  });
  app.get("/api/eval/runs", async (_request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    return { runs: await dependencies.evalEvaluator.listRuns() };
  });
  app.post<{ Body: { baselineRunId?: string; candidateRunId?: string } }>("/api/eval/compare", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    const baseline = request.body?.baselineRunId;
    const candidate = request.body?.candidateRunId;
    if (!baseline || !candidate || baseline === candidate) return reply.code(400).send({ error: "baseline and candidate must be different eval run IDs" });
    const comparison = await dependencies.evalEvaluator.compareRuns(baseline, candidate);
    if (!comparison) return reply.code(404).send({ error: "Evaluation run not found" });
    return comparison;
  });
  app.get("/api/eval/comparisons", async (_request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    return { comparisons: await dependencies.evalEvaluator.listComparisons() };
  });
  app.get<{ Params: { comparisonId: string } }>("/api/eval/comparisons/:comparisonId", async (request, reply) => {
    if (!dependencies.extensions?.isEnabled("owc-eval")) return reply.code(503).send({ error: "owc-eval extension is disabled" });
    if (!dependencies.evalEvaluator) return reply.code(503).send({ error: "eval service is unavailable" });
    const comparison = await dependencies.evalEvaluator.getComparison(request.params.comparisonId);
    if (!comparison) return reply.code(404).send({ error: "Comparison not found" });
    return comparison;
  });
}
