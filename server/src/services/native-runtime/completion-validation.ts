import { nativeSha256 } from "./canonical.js";

/** A server completion guard refused acceptance. Provider prose cannot create it. */
export class NativeCompletionValidationError extends Error {
  readonly code = "native_completion_validation_rejected";
  readonly reason: "source_citation_rejected";
  constructor(reason: "source_citation_rejected") { super(reason); this.reason = reason; }
}

/** Coalesce concurrent checks and retain a rejected result's refusal for this
 * port's lifetime. No second bounded read is triggered by replaying a refusal.
 * Successful checks are not cached across a failed acceptance transaction. */
export class NativeCompletionValidation {
  #pending: { key: string; promise: Promise<void> } | null = null;
  async validate(result: Record<string, unknown>, guard: (result: Record<string, unknown>) => Promise<void>) {
    const key = nativeSha256(result);
    if (this.#pending) {
      if (this.#pending.key !== key) throw new Error("structured_result_replay_conflict");
      return this.#pending.promise;
    }
    const entry = { key, promise: Promise.resolve().then(() => guard(result)) };
    this.#pending = entry;
    try { await entry.promise; this.#pending = null; }
    catch (error) {
      // Only a trusted terminal guard rejection is sticky. Cancellation and
      // infrastructure faults retain their existing ownership/recovery behavior.
      if (!(error instanceof NativeCompletionValidationError)) this.#pending = null;
      throw error;
    }
  }
}
