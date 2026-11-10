import { z } from "zod";

export const MAX_REVIEW_ASSESSMENT_BYTES = 8192;

const ids = z.array(z.string().trim().min(1).max(120)).max(200)
  .refine(values => new Set(values).size === values.length, "Identifiers must be unique");

/** Opt-in; explicit maxReviewRounds remains an independent hard bound. */
export const reviewProgressGuardSchema = z.object({
  mode: z.literal("progress"),
  maxStalledRounds: z.number().int().min(1).max(50).default(3),
}).strict();

/** Submitted only by the current stage reviewer with their decision comment. */
export const issueReviewAssessmentSchema = z.object({
  baselineDecisionId: z.string().guid().nullable(),
  candidateRef: z.string().trim().min(1).max(200),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  openFindingIds: ids,
  requiredGateIds: ids,
  resolvedFindingIds: ids,
  passedGateIds: ids,
}).strict().superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_REVIEW_ASSESSMENT_BYTES) {
    ctx.addIssue({ code: "custom", message: "Review assessment must fit within 8192 UTF-8 bytes" });
  }
});

export const issueReviewProgressStateSchema = z.object({
  stageId: z.string().guid(),
  stalledRounds: z.number().int().nonnegative(),
  openFindingIds: ids,
  requiredGateIds: ids,
  creditedFindingIds: ids,
  creditedGateIds: ids,
  lastAssessment: issueReviewAssessmentSchema.nullable(),
}).strict();

export type ReviewProgressGuard = z.infer<typeof reviewProgressGuardSchema>;
export type IssueReviewAssessment = z.infer<typeof issueReviewAssessmentSchema>;
export type IssueReviewProgressState = z.infer<typeof issueReviewProgressStateSchema>;
