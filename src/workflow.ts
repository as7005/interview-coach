import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from "cloudflare:workers";

type Params = {
  userId: string;
  topic: string;
  agentId: string;
  sessionId: string;
};

const MAX_QUESTIONS = 5;

export class InterviewRunWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { userId, topic, agentId, sessionId } = event.payload;
    const agentStub = this.env.InterviewCoachAgent.get(
      this.env.InterviewCoachAgent.idFromName(agentId)
    );

    const askedQuestions: string[] = [];

    for (let i = 0; i < MAX_QUESTIONS; i++) {
      // Step 1: decide the next question, informed by long-term weak areas
      // AND by what's already been asked this session (avoid repeats).
      const { question, topicArea } = await step.do(
        `pick-question-${i}`,
        async () => this.pickNextQuestion(userId, topic, askedQuestions)
      );
      askedQuestions.push(question);

      await step.do(`push-question-${i}`, async () => {
        await agentStub.pushQuestion(question, topicArea);
      });

      // Step 2: wait for the candidate's answer (sent via agent.submitAnswer,
      // which calls instance.sendEvent). Times out after 10 minutes.
      const answerEvent = await step.waitForEvent<{ answerText: string }>(
        `wait-for-answer-${i}`,
        { type: "answer-submitted", timeout: "10 minutes" }
      );

      // Step 3: score the answer with the LLM.
      const { score, feedback } = await step.do(`score-${i}`, async () =>
        this.scoreAnswer(question, answerEvent.payload.answerText)
      );

      await step.do(`push-feedback-${i}`, async () => {
        await agentStub.pushFeedback(score, feedback);
      });

      // Step 4: persist to long-term memory (D1) so future sessions adapt.
      await step.do(`persist-${i}`, async () =>
        this.persistAnswer({
          sessionId,
          userId,
          topicArea,
          question,
          answer: answerEvent.payload.answerText,
          score,
          feedback,
        })
      );
    }

    // Step 5: wrap up.
    const summary = await step.do("summarize", async () =>
      this.summarizeSession(sessionId, userId)
    );
    await step.do("end-session", async () => {
      await agentStub.endSession(summary);
    });
    await step.do("close-session-row", async () => {
      await this.env.DB.prepare(
        "UPDATE sessions SET ended_at = unixepoch() WHERE id = ?"
      )
        .bind(sessionId)
        .run();
    });

    return { sessionId, questionsAsked: MAX_QUESTIONS };
  }

  /** Reads D1 weak-area scores and asks Llama 3.3 to target the weakest one. */
  private async pickNextQuestion(userId: string, topic: string, askedQuestions: string[]) {
    const weakAreas = await this.env.DB.prepare(
      `SELECT topic_area, avg_score FROM topic_scores
       WHERE user_id = ? ORDER BY avg_score ASC LIMIT 3`
    )
      .bind(userId)
      .all();

    const weakSummary = weakAreas.results.length
      ? weakAreas.results
          .map((r: any) => `${r.topic_area} (avg ${r.avg_score.toFixed(1)}/5)`)
          .join(", ")
      : "no history yet";

    const askedSummary =
      askedQuestions.length > 0
        ? askedQuestions.map((q, idx) => `${idx + 1}. ${q}`).join("\n")
        : "none yet — this is the first question";

    const response: any = await this.env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        messages: [
          {
            role: "system",
            content:
              "You are an expert interview coach for the topic: " +
              topic +
              `. The candidate's weakest tracked areas across past sessions: ${weakSummary}. ` +
              "Ask ONE interview question. If the candidate already scores well " +
              "(4+/5) on the tracked weak areas, or if targeting them would repeat " +
              "a topic already covered this session, move on to a genuinely " +
              "different aspect of the subject instead of narrowing further. " +
              `Questions already asked THIS session (do not repeat these or ask ` +
              `close variations of them):\n${askedSummary}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: {
              question: { type: "string" },
              topicArea: { type: "string" },
            },
            required: ["question", "topicArea"],
          },
        },
      }
    );

    const parsed = extractStructured(response);
    const fallbackPool = [
      "Tell me about a challenging project you worked on.",
      "Describe a time you had to make a decision with incomplete information.",
      "How do you approach debugging a problem you've never seen before?",
    ];
    return {
      question:
        parsed?.question ??
        fallbackPool[askedQuestions.length % fallbackPool.length],
      topicArea: parsed?.topicArea ?? "general",
    };
  }

  /** Scores a candidate's answer 1-5 with structured feedback. */
  private async scoreAnswer(question: string, answer: string) {
    const response: any = await this.env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        messages: [
          {
            role: "system",
            content:
              "You are grading an interview answer. Score 1-5 (5=excellent) and " +
              "give two sentences of specific, constructive feedback referencing " +
              "what the candidate actually said.",
          },
          {
            role: "user",
            content: `Question: ${question}\nAnswer: ${answer}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: {
              score: { type: "integer", minimum: 1, maximum: 5 },
              feedback: { type: "string" },
            },
            required: ["score", "feedback"],
          },
        },
      }
    );

    const parsed = extractStructured(response);
    return {
      score: parsed?.score ?? 3,
      feedback: parsed?.feedback ?? "Solid answer — consider adding a concrete example.",
    };
  }

  private async persistAnswer(row: {
    sessionId: string;
    userId: string;
    topicArea: string;
    question: string;
    answer: string;
    score: number;
    feedback: string;
  }) {
    await this.env.DB.prepare(
      `INSERT INTO answers (session_id, user_id, topic_area, question, answer, score, feedback)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        row.sessionId,
        row.userId,
        row.topicArea,
        row.question,
        row.answer,
        row.score,
        row.feedback
      )
      .run();

    // Update the rolling weak-area average.
    await this.env.DB.prepare(
      `INSERT INTO topic_scores (user_id, topic_area, avg_score, attempts, updated_at)
       VALUES (?, ?, ?, 1, unixepoch())
       ON CONFLICT(user_id, topic_area) DO UPDATE SET
         avg_score = ((avg_score * attempts) + ?) / (attempts + 1),
         attempts = attempts + 1,
         updated_at = unixepoch()`
    )
      .bind(row.userId, row.topicArea, row.score, row.score)
      .run();
  }

  private async summarizeSession(sessionId: string, userId: string) {
    const rows = await this.env.DB.prepare(
      "SELECT topic_area, score FROM answers WHERE session_id = ?"
    )
      .bind(sessionId)
      .all();

    const avg =
      rows.results.reduce((sum: number, r: any) => sum + r.score, 0) /
      (rows.results.length || 1);

    return `Session complete. Average score: ${avg.toFixed(1)}/5 across ${
      rows.results.length
    } questions.`;
  }
}

function extractStructured(response: any): any {
  // With response_format: json_schema, Workers AI returns the parsed object
  // directly on `.response` for some models, or as a JSON string for others.
  // Handle both rather than assuming one shape.
  const raw = response?.response ?? response;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      return null;
    }
  }
  return null;
}