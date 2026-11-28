import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatClientGroup } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { describeError } from "@/api/errors";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/context/ToastContext";

/**
 * Client groups (WhatsApp and Telegram): a group staff share with a client
 * (an academy). Once the client is introduced, here or with
 * "/client <academy name> | <academy id>" in the group, people there who are
 * not on the team are answered as that client's customers.
 */
export function ChatClientGroupsSettings({ endpoint }: { endpoint: ChatEndpoint }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const groups = useQuery({
    queryKey: queryKeys.chatEndpoints.clientGroups(endpoint.id),
    queryFn: () => chatEndpointsApi.clientGroups(endpoint.id),
  });
  const toggle = useMutation({
    mutationFn: (answerClientGroups: boolean) => chatEndpointsApi.update(endpoint.id, { answerClientGroups }),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.chatEndpoints.detail(endpoint.id), next),
    onError: (error) => pushToast({ title: "Couldn’t update client groups", body: describeError(error).body, tone: "error" }),
  });
  const list = groups.data?.groups ?? [];

  return (
    <section className="space-y-4 border-t border-border pt-5" aria-labelledby="chat-client-groups">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="chat-client-groups" className="text-sm font-semibold">Client groups</h3>
          <p className="text-xs text-muted-foreground">
            In a group with a client, people who are not on the team are answered as that client’s customers. Team members can also
            send <code>/client academy name | academy id</code> in the group.
          </p>
        </div>
        <ToggleSwitch
          aria-label="Answer clients in client groups"
          checked={endpoint.setup?.answerClientGroups !== false}
          disabled={toggle.isPending}
          onCheckedChange={(value) => toggle.mutate(value)}
        />
      </div>
      {groups.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading groups…</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">No groups yet. A group appears here after its first message reaches this channel.</p>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((group) => <ClientGroupRow key={group.resourceId} endpointId={endpoint.id} group={group} />)}
        </ul>
      )}
    </section>
  );
}

function ClientGroupRow({ endpointId, group }: { endpointId: string; group: ChatClientGroup }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [academyName, setAcademyName] = useState(group.client?.academyName ?? "");
  const [academyId, setAcademyId] = useState(group.client?.academyId ?? "");
  const save = useMutation({
    mutationFn: (client: { academyName: string; academyId: string } | null) => chatEndpointsApi.setClientGroup(endpointId, group.resourceId, client),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatEndpoints.clientGroups(endpointId) });
    },
    onError: (error) => pushToast({ title: "Couldn’t save the client", body: describeError(error).body, tone: "error" }),
  });
  const valid = academyName.trim().length > 0 && !academyName.includes("|") && /^[\w.:/#-]{1,100}$/.test(academyId.trim());

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{group.label}</p>
          <p className="text-xs text-muted-foreground">
            {group.client ? `Client: ${group.client.academyName} (academy id ${group.client.academyId})` : "No client"}
            {group.availability !== "available" ? " · not reachable" : ""}
          </p>
        </div>
        {!editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {group.client ? "Change" : "Set client"}
          </Button>
        )}
        {!editing && group.client && (
          <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Remove
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate({ academyName: academyName.trim(), academyId: academyId.trim() });
          }}
        >
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Academy name</span>
            <Input className="w-56" value={academyName} onChange={(event) => setAcademyName(event.target.value)} aria-label="Academy name" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="block text-muted-foreground">Academy id</span>
            <Input className="w-32" value={academyId} onChange={(event) => setAcademyId(event.target.value)} aria-label="Academy id" />
          </label>
          <Button type="submit" size="sm" disabled={!valid || save.isPending}>Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
    </li>
  );
}
