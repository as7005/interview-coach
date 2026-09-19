# Mock Interview Coach — Cloudflare Agents SDK

**Live demo:** https://interview-coach.as-khushi26.workers.dev

An AI agent that runs mock interviews, scores your answers with an LLM,
and remembers your weak areas across sessions to target them next time —
speak your answers or type them, either way.

## Components (per assignment requirements)

| Requirement | Implementation |
|---|---|
| LLM | Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, using structured JSON output (`response_format: json_schema`) for reliable question generation and scoring |
| Workflow / coordination | `InterviewCoachAgent` (Agents SDK, Durable Object) hands off each interview run to `InterviewRunWorkflow` (Cloudflare Workflows) for durable, retry-safe multi-step orchestration |
| User input | Chat (typed) and voice (spoken, via mic) — both routed through the same plain HTTP API to the Agent |
| Memory / state | Session state in the Agent's built-in SQLite storage; long-term cross-session memory (weak-area scores, answer history) in D1 — visible in the app as a "your progress across sessions" panel |

## Voice — Workers AI (Whisper + MeloTTS)

Fully wired, not just documented:

- **Speech-to-text**: hold the 🎤 button to record (`MediaRecorder`); the
  audio uploads to `/api/session/:id/voice-answer`, which runs
  `@cf/openai/whisper-large-v3-turbo` and feeds the transcript into the same
  `submitAnswer()` path chat uses.
- **Text-to-speech**: every new coach message is automatically spoken aloud
  via `@cf/myshell-ai/melotts` (`/api/tts`), so the interview feels like a
  real spoken exchange, not just a chat log.
- TTS fails gracefully (returns no audio rather than an error) if the
  partner model has an internal hiccup — the transcript is always there as
  a fallback, so a flaky voice model never breaks the interview flow.

## Why no external paid APIs

Everything runs on Cloudflare's free tier — no OpenAI/ElevenLabs/etc. keys
required or used:

- Workers: 100k requests/day free
- Durable Objects: free on the Workers Free plan
- Workers AI: 10,000 Neurons/day free (covers LLM + Whisper STT + MeloTTS)
- Workflows: 100k requests/day free
- D1: 5GB storage, 5M reads/day free

## Setup

```bash
npm install

# Create the D1 database, then paste the returned database_id into wrangler.jsonc
npx wrangler d1 create interview_coach_db
npm run d1:migrate:local   # for local dev
npm run d1:migrate:remote  # once ready to deploy

npm run dev      # local dev at http://localhost:8787
npm run deploy   # ship it
```

## Project structure

```
src/
  agent.ts     InterviewCoachAgent — live session state, callable methods
               (startSession, submitAnswer, pushQuestion, pushFeedback,
               endSession), scheduled follow-up reminders
  workflow.ts  InterviewRunWorkflow — the actual interview loop: pick
               question → wait for answer → score → persist → repeat,
               tracking already-asked questions to avoid repeats
  index.ts     Worker entry point — plain HTTP API (/api/session,
               /api/session/:id/answer, /api/session/:id/voice-answer,
               /api/session/:id/state, /api/progress/:userId, /api/tts)
               plus static asset serving
  env.d.ts     Typed bindings
public/
  index.html   Frontend — chat + voice UI, cross-session progress panel
schema.sql     D1 schema for long-term memory
```

## Notable engineering decisions (and bugs fixed along the way)

Built iteratively with AI assistance — full history in `PROMPT_HISTORY.md`.
A few real issues that came up and how they were resolved:

- **Durable Object binding naming**: the Agents SDK's URL routing derives
  the client-facing route from the binding name, which must match the
  class name exactly. An initial mismatch (`INTERVIEW_AGENT` vs.
  `InterviewCoachAgent`) caused silent 400s.
- **Frontend transport**: rather than reverse-engineer the Agents SDK's
  internal WebSocket RPC protocol, the frontend talks to the Agent over a
  small, explicit HTTP API (start session / submit answer / poll state) —
  simpler to reason about and verify correctness of.
- **Workflow instance lookup**: `submitAnswer` originally looked up the
  running Workflow instance by the wrong ID (the Agent's own session name
  instead of the Workflow's actual instance ID), causing an
  `instance.not_found` error — fixed by storing the real Workflow ID in
  Agent state at session start.
- **Structured output over prompt-based JSON**: initial scoring used
  freeform prompting ("respond only as JSON") with a regex fallback, which
  silently fell back to generic feedback whenever the model didn't comply.
  Switched to Workers AI's native `response_format: json_schema` for
  reliable structured output.
- **Repeated questions**: weak-area targeting could get stuck re-asking the
  same question once one topic area dominated the "weakest" list — fixed
  by passing the session's already-asked questions into the prompt.

## Prompt history

See `PROMPT_HISTORY.md` for the full AI-assisted development conversation,
per the assignment's disclosure requirement.