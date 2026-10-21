# 0030. Details are collected with form cards in the thread, and never merge contacts

Status: accepted (2026-10-21).

## Context

Support needs a name, an email, a phone number or a callback number at different moments: before a chat, when a person is about to take it, when nobody is there, after it ended. Reading these out of free text is unreliable and invites prompt injection; a pre-chat form for everything loses visitors. An anonymous visitor can type any email, including that of an existing customer, and must not get that customer's history.

## Decision

- A form is a structured bot message (`meta.card.type = contact_form`) with the fields, whether it can be skipped and the consent line. It is created by the server at configured moments or by an agent tool, at most once per moment and ticket (a compare-and-set on `tickets.meta.info_asked` makes two concurrent callers send one card), and only for what the contact lacks.
- The visitor answers through one endpoint that validates everything (the widget validates too, for speed). The card is closed with a compare-and-set on the message's metadata, so a double submit stores once.
- The submitted email and phone are linked to the visitor's contact only when no other contact has them. Otherwise they are stored as `unverified_*` attributes, the response is identical, and merging stays with the existing signed-identity and OTP checks. This costs a little convenience (the team merges by hand when it is the same person) and removes both the history leak and an existence oracle.
- Settings have workspace defaults and a department override of the fields and moments. Defaults are all off.
- A honeypot field stores nothing and reports success.

## Alternatives considered

- **Parse contact details from free text**: no UI work, but unreliable, no consent, and an injection channel.
- **Merge on matching email**: convenient; lets anyone read any customer's history by typing their address.
- **Send an OTP to the typed address to verify it**: right answer when the chat is about an account, but it makes each form an email-sending endpoint with abuse and cost implications; left for a later step.

## Consequences

- A visitor who is a known customer but is not signed in stays a separate contact until the team merges them or they verify.
- The `after` moment asks for an address to follow up. Sending transcripts was built later ([TRANSCRIPTS.md](../TRANSCRIPTS.md)); a copy goes only to an address confirmed by a code or given with consent outside the pre-chat form.
