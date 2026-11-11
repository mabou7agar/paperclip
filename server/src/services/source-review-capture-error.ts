import { HttpError } from "../errors.js";

/** Raised only by the trusted source owner; never classified from provider text. */
export class SourceReviewCaptureUnavailable extends HttpError {
  readonly reason: string;
  constructor(reason: string) {
    super(409, `review_candidate_capture_unavailable:${reason}`, { code: "review_candidate_capture_unavailable", reason });
    this.reason = reason;
  }
}
