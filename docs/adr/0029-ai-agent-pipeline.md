# 0029. The AI agent is a read-only decision followed by a write, with a rules agent underneath

Status: accepted (2026-10-21).

## Context

An AI agent answers customers in the name of the workspace. It must not say what the knowledge base does not support, must never be talked out of its rules by a visitor, must keep working when the model is slow, wrong or absent, must stop the moment a person takes the ticket, and the team must be able to try it without creating tickets. Handoffs and replies happen while people and other bots write to the same ticket.

## Decision

- **Two functions per turn.** `decideTurn` only reads (classification, hand-off triggers, retrieval, the model call, the guards) and returns a `Decision`; `applyDecision` writes (the bot message, the hand-off, the tool actions, the turn record). The sandbox calls `decideTurn` with `dryRun`, so what the team tries is the production code, not a copy.
- **Deterministic first, model second.** Whether a visitor asks for a person, a sensitive word, urgency, sentiment, a department guess and an injection attempt are decided by rules before any model is called; a message that triggers a hand-off or looks like an injection never reaches the model. The model only turns retrieved entries into an answer and may propose a closed list of tools.
- **Untrusted text is data.** Visitor words, knowledge entries and page context are delimited in the prompt and declared to be data written by third parties; the model's output is parsed with zod, tools are validated and checked against the agent's allowed actions, departments and autonomy, and answers pass guards (banned claims, ungrounded commitments, links that are not the entry's own) before a visitor can read them.
- **A rules agent under the model.** `HeuristicProvider` answers from the best entry with no network. It is used when no model is configured, when the model fails or answers with something unusable, and when the workspace's AI budget is used up. A double failure hands over to a person; it never leaves the visitor in silence.
- **Hand-off is routing, not a flag.** An agent hands over through `handoffTicket` ([ADR 0028](0028-departments-are-inboxes.md)), so capacity, hours, queues and notifications behave exactly as for any other handoff. A person claiming a ticket sets the handler; the pipeline re-reads the handler and the status right before it writes (`stillMine`) and aborts if a person has the ticket or it ended while the model was thinking.
- **Quick replies are server-owned.** The visitor's tap is stored as their own message and the card is closed with a compare-and-set on the card's metadata, so a double tap or a retry acts once.
- **Every tool call is audited and visible to the team**, not to the visitor.

## Alternatives considered

- **One function that reads and writes**, with a sandbox flag threaded through every write: simpler to start, but every new side effect is a chance for the sandbox to leak into real data.
- **Let the model decide everything, including hand-offs and refusals**: fewer rules to maintain, but a prompt-injected model can then decide not to hand over; a deterministic floor does not depend on model behaviour.
- **Fail closed when the model is down** (hand every ticket to a person): safe, but turns a provider outage into a queue flood; the rules agent covers the common questions and the guards still apply.
- **Streaming the answer**: nicer in the widget, but guards run on the whole answer; not built.

## Consequences

- A turn is a few queries plus one model call; the model call happens outside any transaction, and the apply step re-checks the ticket state, so a slow model cannot block routing.
- The re-check before writing is a read followed by writes, not one atomic statement: if a person claims in the few statements between them, one last agent message can land after the claim. It is a visible, harmless line in the transcript, and the next visitor message is not answered by the agent.
- The prompt and JSON contract are tested with scripted providers only; nothing here has been measured against a real model.
- The default sensitive-topic list is a starting point in five languages, not a classifier: it will miss paraphrases and will hand over some harmless messages that contain a listed word. The list is the workspace's to edit.
