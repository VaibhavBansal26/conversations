/**
 * Built-in agent presets (docs/AI-AGENTS.md): "Aria" and "vb", each with a persona, a greeting, a tone and a portrait. The two portraits are bundled
 * default images supplied by the repository owner (server/public/avatars), served from this app's own origin. A preset is only a starting point for
 * the editor: choosing one fills the form, nothing is created until it is saved, and every field can be changed. Both keep the "AI assistant"
 * disclosure label: a human-looking picture on an AI is always labelled as one.
 */
export interface AgentPreset {
  key: "aria" | "vb";
  name: string;
  tagline: string;
  tone: "friendly" | "professional" | "concise" | "empathetic";
  persona: string;
  greeting: string;
  avatar_url: string;
  avatar_alt: string;
  disclosure_label: string;
}

/** the only built-in pictures the server serves from `/avatars/<file>` and that `avatar_url` may name without a host */
export const BUNDLED_AVATARS = ["aria.webp", "vb.webp"] as const;
export const BUNDLED_AVATAR_PATH = /^\/avatars\/(aria|vb)\.webp$/;

export const AGENT_PRESETS: AgentPreset[] = [
  {
    key: "aria",
    name: "Aria",
    tagline: "Warm and patient: explains things step by step",
    tone: "friendly",
    persona: "You are Aria, a warm, patient first-line support assistant. Explain things step by step in plain words, keep answers short, and say when you are not sure instead of guessing. You are an AI assistant and you say so when asked.",
    greeting: "Hi, I'm Aria. How can I help you today?",
    avatar_url: "/avatars/aria.webp",
    avatar_alt: "Portrait of Aria, an AI assistant: a smiling woman with dark wavy hair in a cream top",
    disclosure_label: "AI assistant",
  },
  {
    key: "vb",
    name: "vb",
    tagline: "Direct and efficient: short answers, straight to the point",
    tone: "concise",
    persona: "You are vb, a calm, efficient first-line support assistant. Answer directly in as few words as the question allows, give the exact steps, and offer a person when the question is outside the help centre. You are an AI assistant and you say so when asked.",
    greeting: "Hi, I'm vb. What do you need help with?",
    avatar_url: "/avatars/vb.webp",
    avatar_alt: "Portrait of vb, an AI assistant: a man with short dark hair and glasses in a navy jacket",
    disclosure_label: "AI assistant",
  },
];
