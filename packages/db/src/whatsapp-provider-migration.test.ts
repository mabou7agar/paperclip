import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("WhatsApp chat provider migration", () => {
  it("admits whatsapp endpoints and principals, and one live endpoint per linked number", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-whatsapp-provider-");
    const sql = postgres(database.connectionString, { max: 1 });
    try {
      const company = randomUUID(), agent = randomUUID(), application = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'WhatsApp company', 'WAP')`;
      await sql`INSERT INTO agents (id, company_id, name, role, status, adapter_type) VALUES (${agent}, ${company}, 'Agent', 'general', 'idle', 'process')`;
      await sql`INSERT INTO tool_applications (id, company_id, application_key, name, type, status) VALUES (${application}, ${company}, 'whatsapp', 'WhatsApp', 'chat', 'active')`;
      const endpoint = async (status: string, botExternalId: string | null) => {
        const connection = randomUUID(), id = randomUUID();
        await sql`INSERT INTO tool_connections (id, company_id, application_id, name, uid, connection_purpose, transport, status, enabled) VALUES (${connection}, ${company}, ${application}, 'WhatsApp', ${`whatsapp/${connection}`}, 'channel', 'chat_sdk', 'active', true)`;
        await sql`INSERT INTO chat_endpoints (id, company_id, connection_id, provider, public_id, assigned_agent_id, status, provider_account_id, bot_external_id) VALUES (${id}, ${company}, ${connection}, 'whatsapp', ${randomUUID()}, ${agent}, ${status}, 'whatsapp', ${botExternalId})`;
        return id;
      };

      const first = await endpoint("active", "4915550001");
      // A second live channel for the same number violates the partial unique index.
      await expect(endpoint("verifying", "4915550001")).rejects.toMatchObject({ code: "23505" });
      // Unlinked drafts and other numbers are fine.
      await endpoint("draft", null);
      await endpoint("draft", null);
      await endpoint("active", "4915550002");
      // Archiving frees the number for a new channel.
      await sql`UPDATE chat_endpoints SET status = 'archived' WHERE id = ${first}`;
      await endpoint("verifying", "4915550001");

      await sql`INSERT INTO chat_external_principals (company_id, provider, provider_account_id, external_id, kind) VALUES (${company}, 'whatsapp', 'whatsapp', '4915550001', 'user')`;
      await sql`INSERT INTO chat_external_principals (company_id, provider, provider_account_id, external_id, kind) VALUES (${company}, 'whatsapp', 'whatsapp', 'lid:123456789', 'user')`;
      expect(await sql`SELECT count(*)::int AS count FROM chat_external_principals WHERE provider = 'whatsapp'`).toEqual([{ count: 2 }]);

      // The widened constraint still refuses unknown providers.
      await expect(sql`UPDATE chat_endpoints SET provider = 'signal' WHERE id = ${first}`).rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  });
});
