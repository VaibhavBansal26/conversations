# 0034. Agent portraits, bundled presets and a face that does not pretend

Status: accepted (2026-10-21).

## Context

A call with an AI agent needs a face. Workspace owners want to use real portrait photographs for their agents, and the repository owner supplied two (Aria and vb) to ship as defaults. A photograph of a person on an AI agent has two risks: a visitor could take it for a human, and animating it (lip-sync) would suggest a video of a real person speaking. The repository has no image library, and uploaded pictures can carry camera and location data.

## Decision

1. **The face has two looks and one rule.** A photo avatar is never lip-synced and never blinks: it gets a glow ring and a small scale that follow the audio level, a speaking-bars indicator, thinking dots and a state colour (idle, listening, thinking, speaking). Without a photo, or when the photo fails to load, a stylised SVG face is drawn whose mouth follows the voice and which blinks. The level comes from an `AnalyserNode` on the assistant's audio when there is one (the realtime engine) and from word boundaries of the browser's voice otherwise. Reduced motion stops all animation by itself; the state stays visible as colour and indicators. The state machine (`faceNext`) is a pure function with a property test.
2. **The disclosure label is part of the face.** The chip "AI assistant" (the agent's `disclosure_label`, at least two characters, enforced by the schema) is rendered inside the face component, in the widget header next to the name, and beside the avatar in every bubble. No setting removes it. The screen-reader description is the picture's alt text plus the label.
3. **Uploads are validated, not trusted.** `POST /api/agents/:id/avatar` accepts PNG, JPEG (baseline) or WebP by magic bytes up to 1 MB and 64 to 4096 pixels, refuses animation, and removes every metadata block (EXIF, XMP, ICC, text chunks, comments, thumbnails) by rewriting the file's structure. There is no re-encoding because there is no image library; the web editor crops to a square on a canvas first (which also drops EXIF). The file is stored through the existing storage interface under the workspace, and served from `GET /avatars/agent/:id` without credentials (it is shown to visitors) with a fixed image type, `nosniff`, a sandboxing CSP and `Cross-Origin-Resource-Policy: cross-origin`. Replacing, pointing `avatar_url` elsewhere, removing the picture or deleting the agent deletes the stored file.
4. **Two bundled portraits, an allow-list, and presets.** `server/public/avatars/aria.webp` and `vb.webp` are default images supplied by the repository owner. `avatar_url` may be exactly `/avatars/aria.webp` or `/avatars/vb.webp` (a path on the app's own origin that clients resolve against their API base) or an https address. `GET /avatars/:file` serves only those two names. Presets (`GET /api/agents/presets`, mirrored in the web app and checked equal by a test) give Aria and vb a persona, tone, greeting, alt text and the label; "New agent" offers them and the first-open default agent is Aria with her photo.
5. **Rights.** The editor and the docs tell owners to use only pictures they have the right to use. Tests use generated placeholder images, never the bundled photographs.
6. **A hosted photoreal avatar service is not built.** The face is a component with a state and a level input; a provider that streams video of a talking head (HeyGen or D-ID style) would replace the image with a video element and would need its own consent, cost and "this is not a real person" decisions. Not built, not designed beyond this seam.

## Alternatives considered

- **Lip-syncing the photograph** (warping, a mouth overlay): uncanny at best, deceptive at worst; refused.
- **Re-encoding uploads with an image library**: stronger guarantee (nothing unexpected survives), a native dependency to ship on every platform; the structural cleaner plus the canvas crop covers metadata, and the content-type allow-list covers execution.
- **Signed, expiring URLs for portraits** (like attachments): visitors' pages could not cache or reuse them, and a portrait is public by purpose.
- **Letting a manager hide the label for photo avatars**: no.

## Consequences

- A progressive JPEG is refused with a message (its structure is not handled); a canvas-cropped upload from the web app is always accepted.
- The bundled portraits add about 300 KB to the image; they are served with a one-week cache.
- A photograph of a real person used as an AI's face remains the workspace's responsibility; the product labels it and says so.
