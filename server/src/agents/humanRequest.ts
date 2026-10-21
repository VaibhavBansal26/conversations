/**
 * Does the visitor ask for a person, and is the topic one a first-line AI assistant should not handle? Patterns in the five widget languages
 * (en, es, fr, de, ja) plus Portuguese. The "Talk to a person" button in the widget does not depend on any of this: it always works.
 */
const HUMAN: RegExp[] = [
  // English
  /\b(talk|speak|chat|connect|transfer|put me through|get me|let me (talk|speak))\b[^.\n]{0,25}\b(to|with)?\s*(a |an |the )?(human|real person|real human|live agent|live person|person|people|someone|somebody|representative|operator|manager|supervisor|agent|advisor|adviser|support (team|staff))\b/i,
  /\b(human|real person|live agent|representative|operator|supervisor)\b[^.\n]{0,15}\b(please|now|needed|required)\b/i,
  /\bi (want|need|would like|'d like) (to )?(a |an )?(human|real person|person|agent|representative|someone)\b/i,
  /\bnot (a )?(bot|robot|ai)\b/i,
  // Spanish
  /\b(hablar|conectar|pasar|comunicar)\b[^.\n]{0,25}\b(con )?(una |un )?(persona|humano|agente|asesor|representante|alguien|operador)\b/i,
  /\b(agente|persona) (real|humana)\b/i,
  // French
  /\b(parler|discuter|joindre|contacter)\b[^.\n]{0,25}\b(à |a |avec )?(un |une |quelqu'un|le )?(humain|personne|conseiller|conseillère|agent|représentant|responsable|vrai)\b/i,
  /\bun (vrai )?(humain|conseiller)\b/i,
  // German
  /\b(mit|zu)\b[^.\n]{0,15}\b(einem|einer|dem|der)?\s*(mensch\w*|mitarbeiter\w*|berater\w*|person|kundenservice|support-?mitarbeiter\w*)\b[^.\n]{0,20}\b(sprechen|reden|verbinden|chatten)\b/i,
  /\b(echten|richtigen) (mensch|mitarbeiter|berater)\w*\b/i,
  /\bmenschen sprechen\b/i,
  // Portuguese
  /\bfalar com\b[^.\n]{0,15}\b(um |uma )?(humano|atendente|pessoa|agente|representante)\b/i,
  // Japanese
  /(人間|担当者|オペレーター|オペレータ|スタッフ|係員|有人)(と|に)?(話|つないで|繋いで|対応|代わって)/,
  /(人間|担当者|オペレーター)(に|を)(お願い|替わって|代わって|呼んで)/,
];

export function asksForHuman(text: string): boolean {
  return HUMAN.some((re) => re.test(text));
}

/**
 * Words and phrases that make a topic one for a person, in the widget languages. This is only the DEFAULT of the `sensitive_topics` setting of an AI
 * agent: a workspace edits the list, and whatever it saves is exactly what is checked.
 */
export const DEFAULT_SENSITIVE_TOPICS = [
  "refund", "chargeback", "charge back", "lawsuit", "legal", "attorney", "lawyer", "fraud", "stolen", "harass", "abuse", "medical", "suicide", "self-harm", "self harm",
  "gdpr", "delete my data", "delete my account", "hacked", "compromised", "unauthorized", "unauthorised", "account takeover", "social security", "cancel my account",
  "cancel my subscription", "cancellation", "dispute", "reembolso", "devolución", "devolucion", "abogado", "fraude", "hackeado", "remboursement", "avocat", "plainte", "piraté",
  "erstattung", "rückerstattung", "anwalt", "betrug", "kündigen", "gehackt", "返金", "払い戻し", "弁護士", "詐欺", "解約", "不正アクセス", "ハッキング",
];

export function isSensitiveTopic(text: string, topics: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return topics.some((w) => w.length >= 2 && lower.includes(w.toLowerCase()));
}
