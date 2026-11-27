import { HttpError, unprocessable } from "../../../errors.js";
import { WhatsAppSidecarUnconfiguredError } from "../../whatsapp/config.js";
import {
  WhatsAppSidecarClient,
  WhatsAppSidecarError,
  type WhatsAppLinkStatus,
} from "../../whatsapp/sidecar-client.js";
import type { VerifiedProviderIdentity } from "../runtime-types.js";

/** Constant account id: one WhatsApp number is one global identity. */
export const WHATSAPP_PROVIDER_ACCOUNT_ID = "whatsapp";

/** Map sidecar failures to safe HTTP errors; never echo sidecar bodies or URLs. */
export function whatsAppHttpError(error: unknown): never {
  if (error instanceof WhatsAppSidecarUnconfiguredError)
    throw new HttpError(503, error.message, { code: "whatsapp_unconfigured" });
  if (error instanceof WhatsAppSidecarError) {
    const status =
      error.code === "rejected" ? 422
        : error.code === "not_linked" ? 409
          : error.code === "unauthorized" ? 502
            : 503;
    throw new HttpError(status, error.message, { code: `whatsapp_${error.code}` });
  }
  throw error;
}

/** The identity Paperclip records once the sidecar reports a linked number. */
export function whatsAppIdentityFromStatus(status: WhatsAppLinkStatus): VerifiedProviderIdentity {
  // A saved login that is reconnecting or held paused still proves the
  // number; resume verifies while the socket is coming back.
  const holdsLogin = status.state === "linked" || status.state === "paused" || status.state === "connecting";
  if (!holdsLogin || !status.me)
    throw unprocessable("Link WhatsApp first: scan the QR code (or enter the pairing code) on the phone", {
      code: "whatsapp_not_linked",
    });
  const label = `+${status.me}`;
  return {
    providerAccountId: WHATSAPP_PROVIDER_ACCOUNT_ID,
    providerAccountLabel: label,
    botExternalId: status.me,
    botUsername: label,
    botLabel: label,
  };
}

export function createWhatsAppCredentialChecks(client: WhatsAppSidecarClient) {
  async function verifyWhatsAppCredentials(
    credentials: Record<string, string>,
  ): Promise<VerifiedProviderIdentity> {
    const accountId = credentials.accountId;
    if (!accountId) throw unprocessable("WhatsApp channel identity is missing");
    const status = await client.status(accountId).catch(whatsAppHttpError);
    return whatsAppIdentityFromStatus(status);
  }
  return { verifyWhatsAppCredentials };
}
