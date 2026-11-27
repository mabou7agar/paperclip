import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type WhatsAppLinkView,
} from "@/api/chatEndpoints";
import { describeError } from "@/api/errors";

const POLL_MS = 2_000;

function lastErrorText(code: string | undefined): string | null {
  if (!code) return null;
  if (code === "link_timeout") return "Linking timed out. Start again to get a new code.";
  if (code === "pairing_code_refused") return "WhatsApp refused a pairing code for that number. Check the number or use the QR code.";
  if (code === "logged_out") return "WhatsApp logged this number out. Link it again.";
  return null;
}

/**
 * Link a WhatsApp number to this channel by QR code (WhatsApp refreshes it
 * about every 20 seconds) or by pairing code. Paperclip finishes the channel
 * setup as soon as the phone is linked.
 */
export function WhatsAppConnectStep({
  endpoint,
  agentName,
  repairing,
  onEndpointSaved,
}: {
  endpoint: ChatEndpoint;
  agentName: string;
  repairing: boolean;
  onEndpointSaved: (endpoint: ChatEndpoint) => void;
}) {
  const [usePairingCode, setUsePairingCode] = useState(false);
  const [phone, setPhone] = useState("");
  const [started, setStarted] = useState(false);
  const lastEndpointStatus = useRef(endpoint.status);

  const status = useQuery({
    queryKey: ["whatsapp-link-status", endpoint.id],
    queryFn: () => chatEndpointsApi.whatsAppLinkStatus(endpoint.id),
    refetchInterval: (query) => {
      const data = query.state.data as WhatsAppLinkView | undefined;
      if (!data) return POLL_MS;
      if (data.state === "linked" && data.endpointStatus !== "draft" && data.endpointStatus !== "attention") return false;
      return started || data.state === "qr" || data.state === "pairing_code" || data.state === "connecting" || data.state === "linked"
        ? POLL_MS
        : false;
    },
    retry: false,
  });

  const link = useMutation({
    mutationFn: () =>
      chatEndpointsApi.startWhatsAppLink(
        endpoint.id,
        usePairingCode ? { mode: "code", phone } : { mode: "qr" },
      ),
    onSuccess: () => {
      setStarted(true);
      void status.refetch();
    },
  });

  const unlink = useMutation({
    mutationFn: () => chatEndpointsApi.unlinkWhatsApp(endpoint.id),
    onSuccess: async () => {
      setStarted(false);
      await status.refetch();
      const next = await chatEndpointsApi.get(endpoint.id).catch(() => null);
      if (next) onEndpointSaved(next);
    },
  });

  // When the server has configured the channel from a linked phone, move the
  // wizard on with the canonical endpoint.
  const endpointStatus = status.data?.endpointStatus;
  useEffect(() => {
    if (!endpointStatus || endpointStatus === lastEndpointStatus.current) return;
    lastEndpointStatus.current = endpointStatus;
    void chatEndpointsApi.get(endpoint.id).then(onEndpointSaved, () => undefined);
  }, [endpointStatus, endpoint.id, onEndpointSaved]);

  const view = status.data;
  const busy = link.isPending || unlink.isPending;
  const error = link.error ?? unlink.error ?? status.error;
  const hint = lastErrorText(view?.lastError);
  const phoneDigits = phone.replace(/\D+/g, "");

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">Connect {agentName} to WhatsApp</h1>
        <p className="text-sm text-muted-foreground">
          Use a WhatsApp number dedicated to this agent. On that phone, open WhatsApp, go to
          Settings, then Linked devices, then Link a device.
        </p>
        <p className="text-sm text-muted-foreground">
          This links WhatsApp as a companion device rather than through the WhatsApp Business
          API. Use a number you are prepared to have restricted by WhatsApp.
        </p>
        {repairing && endpoint.botExternalId && (
          <p className="text-sm text-muted-foreground">
            Link the same number again (+{endpoint.botExternalId}). A different number needs a new channel.
          </p>
        )}
      </div>

      {view?.state === "linked" ? (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">Linked as {view.linkedAs ?? "your WhatsApp number"}</p>
          {(view.endpointStatus === "draft" || view.endpointStatus === "attention") && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Finishing setup…
            </p>
          )}
          <Button variant="outline" disabled={busy} onClick={() => unlink.mutate()}>
            {unlink.isPending ? "Unlinking…" : "Unlink"}
          </Button>
        </div>
      ) : view?.state === "qr" && view.qrPngDataUrl ? (
        <div className="space-y-3">
          <img
            src={view.qrPngDataUrl}
            alt="WhatsApp linking QR code"
            className="size-64 rounded-md border bg-white p-2"
          />
          <p className="text-sm text-muted-foreground">
            Scan this with the phone. The code refreshes automatically.
          </p>
        </div>
      ) : view?.state === "pairing_code" && view.code ? (
        <div className="space-y-2">
          <p className="text-sm">On the phone, choose “Link with phone number instead” and enter:</p>
          <p className="font-mono text-3xl tracking-widest" aria-label="Pairing code">
            {view.code.length === 8 ? `${view.code.slice(0, 4)}-${view.code.slice(4)}` : view.code}
          </p>
        </div>
      ) : view?.state === "connecting" && started ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Contacting WhatsApp…
        </p>
      ) : null}

      {view?.state !== "linked" && (
        <div className="space-y-3">
          {usePairingCode && (
            <label className="grid gap-2 text-sm font-medium">
              WhatsApp number with country code
              <Input
                value={phone}
                inputMode="tel"
                autoComplete="off"
                placeholder="+49 151 2345678"
                disabled={busy}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || (usePairingCode && (phoneDigits.length < 7 || phoneDigits.length > 15))}
              onClick={() => link.mutate()}
            >
              {link.isPending
                ? "Starting…"
                : usePairingCode
                  ? "Get pairing code"
                  : view?.state === "qr"
                    ? "Restart linking"
                    : "Show QR code"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setUsePairingCode((value) => !value)}>
              {usePairingCode ? "Use a QR code instead" : "Use a pairing code instead"}
            </Button>
          </div>
        </div>
      )}

      {hint && <p role="status" className="text-sm text-muted-foreground">{hint}</p>}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(error).body}
        </p>
      ) : null}
    </div>
  );
}
