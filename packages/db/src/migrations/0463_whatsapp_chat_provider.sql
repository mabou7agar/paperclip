-- WhatsApp becomes a chat provider. Widening the provider set cannot reject an
-- existing row; NOT VALID + VALIDATE keeps the lock short on large installs.
ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'whatsapp')) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_endpoints" VALIDATE CONSTRAINT "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" DROP CONSTRAINT IF EXISTS "chat_external_principals_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'whatsapp')) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_external_principals" VALIDATE CONSTRAINT "chat_external_principals_provider_check";--> statement-breakpoint
-- One linked WhatsApp number backs at most one live endpoint.
CREATE UNIQUE INDEX IF NOT EXISTS "chat_endpoints_whatsapp_number_uq" ON "chat_endpoints" USING btree ("bot_external_id") WHERE "chat_endpoints"."provider" = 'whatsapp' and "chat_endpoints"."status" <> 'archived' and "chat_endpoints"."bot_external_id" is not null;
