import { routeAgentRequest } from "agents";
import { InterviewCoachAgent } from "./agent";
import { InterviewRunWorkflow } from "./workflow";

export { InterviewCoachAgent, InterviewRunWorkflow };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Plain HTTP API — the frontend talks to the Agent this way (fetch +
    // polling) rather than assuming a specific WebSocket wire protocol.
    if (url.pathname === "/api/session" && request.method === "POST") {
      const { userId, topic } = await request.json<{ userId: string; topic: string }>();
      const sessionName = `${userId}-${Date.now()}`;
      const id = env.InterviewCoachAgent.idFromName(sessionName);
      const stub = env.InterviewCoachAgent.get(id);
      const result = await stub.startSession(userId, topic);
      return Response.json({ sessionName, ...result });
    }

    const answerMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/answer$/);
    if (answerMatch && request.method === "POST") {
      const sessionName = decodeURIComponent(answerMatch[1]);
      const { answerText } = await request.json<{ answerText: string }>();
      const id = env.InterviewCoachAgent.idFromName(sessionName);
      const stub = env.InterviewCoachAgent.get(id);
      const result = await stub.submitAnswer(answerText);
      return Response.json(result);
    }

    const stateMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/state$/);
    if (stateMatch && request.method === "GET") {
      const sessionName = decodeURIComponent(stateMatch[1]);
      const id = env.InterviewCoachAgent.idFromName(sessionName);
      const stub = env.InterviewCoachAgent.get(id);
      const state = await stub.getState();
      return Response.json(state);
    }

    // Cross-session memory, made visible: shows the D1-backed weak-area
    // tracking that carries across separate interview sessions.
    const progressMatch = url.pathname.match(/^\/api\/progress\/([^/]+)$/);
    if (progressMatch && request.method === "GET") {
      const userId = decodeURIComponent(progressMatch[1]);
      const rows = await env.DB.prepare(
        `SELECT topic_area, avg_score, attempts FROM topic_scores
         WHERE user_id = ? ORDER BY avg_score ASC`
      )
        .bind(userId)
        .all();
      return Response.json({ topics: rows.results });
    }

    // Voice input: browser records audio, POSTs the raw bytes here.
    // We transcribe with Whisper, then feed the text into the same
    // submitAnswer() path chat already uses.
    const voiceAnswerMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/voice-answer$/);
    if (voiceAnswerMatch && request.method === "POST") {
      const sessionName = decodeURIComponent(voiceAnswerMatch[1]);
      const arrayBuffer = await request.arrayBuffer();
      const base64Audio = Buffer.from(arrayBuffer).toString("base64");

      const stt: any = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
        audio: base64Audio,
        language: "en",
      });
      const transcript = (stt?.text ?? "").trim();
      if (!transcript) {
        return Response.json({ error: "Could not transcribe audio." }, { status: 400 });
      }

      const id = env.InterviewCoachAgent.idFromName(sessionName);
      const stub = env.InterviewCoachAgent.get(id);
      await stub.submitAnswer(transcript);
      return Response.json({ transcript });
    }

    // Voice output: the frontend asks for the coach's latest line as
    // spoken audio (MP3, base64-encoded) via MeloTTS.
    if (url.pathname === "/api/tts" && request.method === "POST") {
      const { text } = await request.json<{ text: string }>();
      try {
        // MeloTTS (a newer partner model) seems to fail on longer inputs —
        // truncate defensively rather than risk a 500 on every long feedback line.
        const truncated = text.length > 300 ? text.slice(0, 300) + "..." : text;
        const result: any = await env.AI.run("@cf/myshell-ai/melotts", {
          prompt: truncated,
          lang: "en",
        });
        return Response.json({ audio: result.audio ?? null });
      } catch (err) {
        console.error("TTS failed, continuing without audio:", err);
        return Response.json({ audio: null });
      }
    }

    // Agents SDK's own routing (kept available, e.g. for a future
    // WebSocket-based client built against its real protocol).
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Everything else (the chat/voice frontend) is served as static assets.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};