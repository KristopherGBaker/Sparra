export interface WorkItem {
  id: string;
  title: string;
  summary: string;
  dependsOn: string[];
  rationale: string;
  /**
   * Optional generator routing. "local" runs this item on `roles.generatorLocal`
   * (e.g. a local LM Studio model) instead of `roles.generator` — for trivially-simple
   * or privacy-sensitive items. Omitted/"default" → the main generator. The decomposer
   * may tag items (when a local generator is configured); the human can override in
   * items.json before building.
   */
  gen?: "local" | "default";
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
