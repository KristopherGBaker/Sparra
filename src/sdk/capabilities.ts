import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Best-effort probe for whether the SDK 'auto' permission mode (model-classifier
 * approvals) is available on this account/plan. Runs one tiny turn requesting
 * permissionMode 'auto' and checks the init message reflects it without error.
 * Conservative: any failure → treat as unsupported (we fall back to acceptEdits).
 */
export async function probeAutoSupported(cwd: string): Promise<boolean> {
  try {
    let modeSeen: string | undefined;
    for await (const msg of query({
      prompt: "Reply with: OK",
      options: { model: "haiku", maxTurns: 1, permissionMode: "auto", settingSources: [], cwd },
    })) {
      if (msg.type === "system" && (msg as any).subtype === "init") {
        modeSeen = (msg as any).permissionMode;
      }
      if (msg.type === "result") {
        const m = msg as any;
        if (m.subtype !== "success") return false;
      }
    }
    return modeSeen === "auto";
  } catch {
    return false;
  }
}
