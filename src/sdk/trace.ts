import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendText, ensureDir, writeText } from "../util/io.ts";

/**
 * Streams a session's transcript to traces/<runId>/<role>-<seq>.md as readable
 * markdown. This is what `--reflect` reads later, and what you read to debug.
 */
export class TraceWriter {
  private opened = false;
  constructor(public readonly file: string, private readonly header: string) {}

  static for(traceDir: string, role: string, seq: number, header: string): TraceWriter {
    const file = path.join(traceDir, `${String(seq).padStart(2, "0")}-${role}.md`);
    return new TraceWriter(file, header);
  }

  private async open(): Promise<void> {
    if (this.opened) return;
    await ensureDir(path.dirname(this.file));
    await writeText(this.file, this.header + "\n");
    this.opened = true;
  }

  async write(md: string): Promise<void> {
    await this.open();
    await appendText(this.file, md);
  }

  async record(msg: SDKMessage): Promise<void> {
    const md = renderMessage(msg);
    if (md) await this.write(md);
  }
}

function fence(lang: string, body: string): string {
  return "```" + lang + "\n" + body.trimEnd() + "\n```\n\n";
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + `\n… [${s.length - max} more chars truncated]` : s;
}

/** Render one SDK message to a markdown chunk (or "" to skip). */
export function renderMessage(msg: SDKMessage): string {
  switch (msg.type) {
    case "system":
      if ((msg as any).subtype === "init") {
        const m = msg as any;
        return `### ⚙️ session init\n- model: \`${m.model}\`\n- session_id: \`${m.session_id}\`\n- permissionMode: \`${m.permissionMode}\`\n- cwd: \`${m.cwd}\`\n\n`;
      }
      if ((msg as any).subtype === "compact_boundary") {
        return `> 🗜️ _context compacted_\n\n`;
      }
      return "";
    case "assistant": {
      const content = (msg as any).message?.content ?? [];
      let out = "";
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          out += `**assistant:**\n\n${block.text.trim()}\n\n`;
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          out += `<details><summary>🧠 thinking</summary>\n\n${truncate(block.thinking.trim(), 2000)}\n\n</details>\n\n`;
        } else if (block.type === "tool_use") {
          out += `**→ tool:** \`${block.name}\`\n\n` + fence("json", truncate(JSON.stringify(block.input ?? {}, null, 2), 2000));
        }
      }
      return out;
    }
    case "user": {
      const content = (msg as any).message?.content;
      if (typeof content === "string") return "";
      let out = "";
      for (const block of content ?? []) {
        if (block.type === "tool_result") {
          const body =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
              ? block.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
              : JSON.stringify(block.content);
          const tag = block.is_error ? "tool error" : "tool result";
          out += `_${tag}:_\n\n` + fence("text", truncate(String(body), 2500));
        }
      }
      return out;
    }
    case "result": {
      const m = msg as any;
      return `---\n\n### 🏁 result (${m.subtype})\n- turns: ${m.num_turns}\n- cost: $${Number(m.total_cost_usd ?? 0).toFixed(4)}\n${m.errors?.length ? `- errors: ${m.errors.join("; ")}\n` : ""}\n`;
    }
    default:
      return "";
  }
}
