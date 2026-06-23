export interface WorkItem {
  id: string;
  title: string;
  summary: string;
  dependsOn: string[];
  rationale: string;
}

export interface Verdict {
  assertions: { id: number; pass: boolean; evidence: string }[];
  scores: { design: number; originality: number; craft: number; functionality: number };
  weightedTotal: number;
  verdict: "pass" | "fail";
  blocking: string[];
  notes: string;
}

export const RUBRIC_CRITERIA = ["design", "originality", "craft", "functionality"] as const;
export type Criterion = (typeof RUBRIC_CRITERIA)[number];
