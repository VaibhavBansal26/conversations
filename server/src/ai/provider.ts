import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import { HeuristicProvider } from "./heuristic.js";

export type AiTask = "suggest_replies" | "summarize" | "triage" | "rephrase" | "autorespond" | "agent_answer";

export interface AiRequest {
  task: AiTask;
  system: string;
  /** Full prompt for LLM providers. Contains delimited, untrusted conversation text. */
  prompt: string;
  /** Structured twin of the prompt for the offline heuristic provider (never sent to a network). */
  input: Record<string, unknown>;
  maxTokens: number;
}

export interface AiProvider {
  readonly name: string;
  /** Returns the raw model text (expected to be JSON). Throws on transport errors, timeouts and refusals. */
  complete(req: AiRequest): Promise<string>;
}

export class AiUnavailableError extends Error {
  constructor(message = "AI is unavailable right now") {
    super(message);
    this.name = "AiUnavailableError";
  }
}
export class AiOutputError extends Error {
  constructor(message = "The AI returned an unusable answer") {
    super(message);
    this.name = "AiOutputError";
  }
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    timeoutMs: number,
  ) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  }

  async complete(req: AiRequest): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    });
    if (res.stop_reason === "refusal") throw new AiUnavailableError("The model declined this request");
    return res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  }
}

export function createAiProvider(config: Pick<Config, "ANTHROPIC_API_KEY" | "ANTHROPIC_MODEL" | "AI_TIMEOUT_MS">): AiProvider {
  return config.ANTHROPIC_API_KEY ? new AnthropicProvider(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL, config.AI_TIMEOUT_MS) : new HeuristicProvider();
}
