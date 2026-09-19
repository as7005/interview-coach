# Mock Interview Coach — Cloudflare Agents SDK

An AI agent that runs mock interviews, scores your answers with an LLM,
and remembers your weak areas across sessions to target them next time.

## Components (per assignment requirements)

| Requirement | Implementation |
|---|---|
| LLM | Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Workflow / coordination | `InterviewCoachAgent` (Agents SDK, Durable Object) hands off each interview run to `InterviewRunWorkflow` (Cloudflare Workflows) for durable, retry-safe multi-step orchestration |
| User input | Chat via WebSocket + static frontend (Pages-style assets). Voice extension point documented in `public/index.html` and below. |
| Memory / state | Session state in the Agent's built-in SQLite storage; long-term cross-session memory (weak-area scores, answer history) in D1 |

## Why no external paid APIs

Everything runs on Cloudflare's free tier:

- Workers: 100k requests/day free
- Durable Objects: free on the Workers Free plan
- Workers AI: 10,000 Neurons/day free (covers LLM + Whisper STT + TTS)
- Workflows: 100k requests/day free
- D1: 5GB storage, 5M reads/day free
- Realtime (voice, formerly "Calls"): 1,000 GB egress/month free

No OpenAI/ElevenLabs/etc. keys are required or used.

## Setup

```bash
npm install

# Create the D1 database, then paste the returned database_id into wrangler.jsonc
npx wrangler d1 create interview_coach_db
npm run d1:migrate:local   # for local dev
npm run d1:migrate:remote  # once deployed

npm run dev      # local dev at http://localhost:8787
npm run deploy   # ship it
```

## Project structure

```
src/
  agent.ts     InterviewCoachAgent — live session state, @callable() RPC methods,
               scheduled follow-up reminders
  workflow.ts  InterviewRunWorkflow — the actual interview loop: pick question →
               wait for answer → score → persist → repeat
  index.ts     Worker entry point, routes /agents/* to the Agent, everything
               else to the static frontend
  env.d.ts     Typed bindings
public/
  index.html   Chat frontend (WebSocket to the Agent)
schema.sql     D1 schema for long-term memory
```

## Voice (Cloudflare Workers AI — Whisper + MeloTTS)

Fully wired, not just documented:

- **Speech-to-text**: hold the 🎤 button to record (`MediaRecorder`), the audio
  uploads to `/api/session/:id/voice-answer`, which runs
  `@cf/openai/whisper-large-v3-turbo` and feeds the transcript into the same
  `submitAnswer()` path chat uses.
- **Text-to-speech**: every new coach message is automatically spoken aloud
  via `@cf/myshell-ai/melotts` (`/api/tts`), so the interview feels like a
  real spoken exchange, not just a chat log.

Note: browsers block audio autoplay before the first user gesture on the
page — since clicking "Start" counts as a gesture, this works in practice,
but if a browser still blocks it, the transcript is always there as a
fallback.

## Prompt history

See `PROMPT_HISTORY.md` — paste your full conversation export there before
submitting, per the assignment's AI-assisted-coding disclosure requirement.