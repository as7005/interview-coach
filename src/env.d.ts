import type { InterviewCoachAgent } from "./agent";
import type { InterviewRunWorkflow } from "./workflow";

declare global {
  interface Env {
    AI: Ai;
    DB: D1Database;
    ASSETS: Fetcher;
    InterviewCoachAgent: DurableObjectNamespace<InterviewCoachAgent>;
    INTERVIEW_WORKFLOW: Workflow<InterviewRunWorkflow>;
  }
}

export {};