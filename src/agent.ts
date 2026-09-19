import { Agent, callable, type Connection } from "agents";

export type InterviewState = {
  userId: string | null;
  topic: string | null;
  status: "idle" | "running" | "finished";
  currentQuestion: string | null;
  currentTopicArea: string | null;
  transcript: { role: "coach" | "candidate"; text: string }[];
  questionsAsked: number;
  lastScore: number | null;
  workflowId: string | null;
};

const INITIAL_STATE: InterviewState = {
  userId: null,
  topic: null,
  status: "idle",
  currentQuestion: null,
  currentTopicArea: null,
  transcript: [],
  questionsAsked: 0,
  lastScore: null,
  workflowId: null,
};

export class InterviewCoachAgent extends Agent<Env, InterviewState> {
  initialState = INITIAL_STATE;

  // Broadcast state changes to any connected chat/voice client.
  onStateUpdate(state: InterviewState, source: Connection | "server") {
    this.broadcast(JSON.stringify({ type: "state", state }));
  }

  /** Plain DO RPC method — called from the Worker's HTTP handler, not a client. */
  async getState() {
    return this.state;
  }

  /** Start (or restart) an interview session for a given user + topic. */
  @callable()
  async startSession(userId: string, topic: string) {
    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO users (id) VALUES (?)"
    )
      .bind(userId)
      .run();

    const sessionId = crypto.randomUUID();
    await this.env.DB.prepare(
      "INSERT INTO sessions (id, user_id, topic) VALUES (?, ?, ?)"
    )
      .bind(sessionId, userId, topic)
      .run();

    this.setState({
      ...INITIAL_STATE,
      userId,
      topic,
      status: "running",
      workflowId: sessionId,
    });

    // Hand off the actual multi-step interview logic to a Workflow.
    // The Workflow calls back into this Agent (via RPC / HTTP) as it
    // produces each question and receives each answer.
    await this.env.INTERVIEW_WORKFLOW.create({
      id: sessionId,
      params: { userId, topic, agentId: this.name, sessionId },
    });

    return { sessionId };
  }

  /** Called by the frontend when the candidate answers (voice-to-text or typed). */
  @callable()
  async submitAnswer(answerText: string) {
    if (this.state.status !== "running" || !this.state.currentQuestion) {
      return { error: "No active question." };
    }

    this.setState({
      ...this.state,
      transcript: [
        ...this.state.transcript,
        { role: "candidate" as const, text: answerText },
      ],
    });

    // Signal the waiting Workflow step that an answer has arrived.
    // (Workflows expose `sendEvent` for external wakeups.)
    if (!this.state.workflowId) {
      return { error: "No workflow ID on this session." };
    }
    const instance = await this.env.INTERVIEW_WORKFLOW.get(this.state.workflowId);
    await instance.sendEvent({
      type: "answer-submitted",
      payload: { answerText },
    });

    return { ok: true };
  }

  /** Called by the Workflow to push the next question down to the client. */
  @callable()
  async pushQuestion(question: string, topicArea: string) {
    const last = this.state.transcript[this.state.transcript.length - 1];
    if (last && last.role === "coach" && last.text === question) {
      return; // already recorded — avoid duplicate on step replay
    }
    this.setState({
      ...this.state,
      currentQuestion: question,
      currentTopicArea: topicArea,
      questionsAsked: this.state.questionsAsked + 1,
      transcript: [
        ...this.state.transcript,
        { role: "coach" as const, text: question },
      ],
    });
  }

  /** Called by the Workflow once an answer has been scored. */
  @callable()
  async pushFeedback(score: number, feedback: string) {
    const last = this.state.transcript[this.state.transcript.length - 1];
    if (last && last.role === "coach" && last.text === feedback) {
      return; // already recorded — avoid duplicate on step replay
    }
    this.setState({
      ...this.state,
      lastScore: score,
      transcript: [
        ...this.state.transcript,
        { role: "coach" as const, text: feedback },
      ],
    });
  }

  /** Called by the Workflow when the interview is complete. */
  @callable()
  async endSession(summary: string) {
    this.setState({ ...this.state, status: "finished" });
    this.broadcast(JSON.stringify({ type: "summary", summary }));

    // Schedule a spaced-repetition nudge 3 days later, reusing the
    // Agent's built-in cron-like scheduler.
    if (this.state.userId) {
      await this.schedule(3 * 24 * 60 * 60, "sendFollowUpReminder", {
        userId: this.state.userId,
      });
    }
  }

  /** Scheduled callback - runs days later even if nobody is connected. */
  async sendFollowUpReminder(data: { userId: string }) {
    // In production: send an email/push notification via an Email Worker.
    console.log(`Reminder: ${data.userId} is due for another mock interview.`);
  }
}