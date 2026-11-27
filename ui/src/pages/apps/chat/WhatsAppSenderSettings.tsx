import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { describeError } from "@/api/errors";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/context/ToastContext";

const DEFAULT_LIMIT = { messages: 10, windowMinutes: 10 };

/**
 * WhatsApp channel settings: what happens to messages from people who are not
 * linked to a Paperclip user, the per-customer message limit, and whether
 * owner question cards are pushed to the linked owner's WhatsApp.
 */
export function WhatsAppSenderSettings({ endpoint }: { endpoint: ChatEndpoint }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const policy = endpoint.setup?.whatsAppUnknownSenders ?? (endpoint.allowUnlinkedPeople ? "client" : "ignore");
  const limit = endpoint.setup?.whatsAppCustomerRateLimit ?? DEFAULT_LIMIT;
  const [messages, setMessages] = useState(String(limit.messages));
  const [windowMinutes, setWindowMinutes] = useState(String(limit.windowMinutes));
  useEffect(() => {
    setMessages(String(limit.messages));
    setWindowMinutes(String(limit.windowMinutes));
  }, [limit.messages, limit.windowMinutes]);

  const update = useMutation({
    mutationFn: (input: Parameters<typeof chatEndpointsApi.update>[1]) => chatEndpointsApi.update(endpoint.id, input),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.chatEndpoints.detail(endpoint.id), next),
    onError: (error) => pushToast({ title: "Couldn’t update WhatsApp settings", body: describeError(error).body, tone: "error" }),
  });

  const parsedMessages = Number(messages);
  const parsedWindow = Number(windowMinutes);
  const limitValid =
    Number.isInteger(parsedMessages) && parsedMessages >= 1 && parsedMessages <= 200 &&
    Number.isInteger(parsedWindow) && parsedWindow >= 1 && parsedWindow <= 1440;
  const limitChanged = parsedMessages !== limit.messages || parsedWindow !== limit.windowMinutes;

  return (
    <section className="space-y-4 border-t border-border pt-5" aria-labelledby="whatsapp-unknown-senders">
      <div>
        <h3 id="whatsapp-unknown-senders" className="text-sm font-semibold">People who are not linked</h3>
        <p className="text-xs text-muted-foreground">Linked team members always use their own Paperclip permissions.</p>
      </div>
      <fieldset className="space-y-2" disabled={update.isPending}>
        <legend className="sr-only">Unknown senders</legend>
        <label className="flex items-start gap-3 text-sm">
          <input type="radio" name="whatsapp-unknown-senders" className="mt-1" checked={policy === "ignore"}
            onChange={() => update.mutate({ whatsAppUnknownSenders: "ignore" })} />
          <span>
            <span className="font-medium">Ignore</span>
            <span className="block text-xs text-muted-foreground">Messages from unknown numbers get no reply.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="radio" name="whatsapp-unknown-senders" className="mt-1" checked={policy === "client"}
            onChange={() => update.mutate({ whatsAppUnknownSenders: "client" })} />
          <span>
            <span className="font-medium">Answer as customers</span>
            <span className="block text-xs text-muted-foreground">
              The agent answers questions about your products and the customer’s own account, orders and support. Customers never see
              internal work, cannot approve anything and cannot act on Paperclip.
            </span>
          </span>
        </label>
      </fieldset>
      {policy === "client" && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (limitValid) update.mutate({ whatsAppCustomerRateLimit: { messages: parsedMessages, windowMinutes: parsedWindow } });
          }}
        >
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Messages per customer</span>
            <Input className="w-24" inputMode="numeric" value={messages} onChange={(event) => setMessages(event.target.value)} aria-label="Messages per customer" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Within minutes</span>
            <Input className="w-24" inputMode="numeric" value={windowMinutes} onChange={(event) => setWindowMinutes(event.target.value)} aria-label="Within minutes" />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={!limitValid || !limitChanged || update.isPending}>Save limit</Button>
          {!limitValid && <p className="w-full text-xs text-destructive">Use 1–200 messages within 1–1440 minutes.</p>}
        </form>
      )}
      <div className="flex items-center gap-3 border-t border-border pt-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Send owner questions to WhatsApp</p>
          <p className="text-xs text-muted-foreground">Approvals and questions waiting for the owner arrive as numbered messages; reply with the number to answer.</p>
        </div>
        <ToggleSwitch
          aria-label="Send owner questions to WhatsApp"
          checked={endpoint.setup?.ownerCardPush !== false}
          disabled={update.isPending}
          onCheckedChange={(value) => update.mutate({ ownerCardPush: value })}
        />
      </div>
    </section>
  );
}
