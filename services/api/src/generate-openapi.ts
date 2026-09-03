/**
 * Generates `services/api/openapi.json`. Kept deliberately minimal (as the
 * task allows): every PLAN §9 schema becomes a JSON Schema component via
 * `zod-to-json-schema`, and every PLAN §12 route becomes a path entry with
 * its declared auth and, where a body is validated, a `$ref` to the
 * matching schema. `pnpm --filter @thenar/api openapi` (or `pnpm
 * openapi:api` from the root) regenerates it; run it again whenever a
 * route or schema changes.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CaptureManifest } from "./schemas/manifest.ts";
import { CorpusManifest } from "./schemas/corpusManifest.ts";
import { VerificationClaim } from "./schemas/verificationClaim.ts";
import { ConsentRecord } from "./schemas/consentRecord.ts";
import { AppendReceipt } from "./schemas/appendReceipt.ts";
import { Report } from "./schemas/report.ts";
import {
  CreateKeyBody, CreateUploadBody, CreateDatasetBody, IngestDatasetBody, CreateEpisodeBody, RevokeConsentBody,
} from "./schemas/requests.ts";

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: {
          type: "string",
          enum: [
            "invalid_request", "unauthorized", "forbidden", "not_found", "conflict",
            "unprocessable", "rate_limited", "not_implemented", "internal",
          ],
        },
        message: { type: "string" },
        details: {},
      },
    },
  },
};

const schemas: Record<string, unknown> = {
  CaptureManifest: zodToJsonSchema(CaptureManifest, "CaptureManifest").definitions?.CaptureManifest,
  CorpusManifest: zodToJsonSchema(CorpusManifest, "CorpusManifest").definitions?.CorpusManifest,
  VerificationClaim: zodToJsonSchema(VerificationClaim, "VerificationClaim").definitions?.VerificationClaim,
  ConsentRecord: zodToJsonSchema(ConsentRecord, "ConsentRecord").definitions?.ConsentRecord,
  AppendReceipt: zodToJsonSchema(AppendReceipt, "AppendReceipt").definitions?.AppendReceipt,
  Report: zodToJsonSchema(Report, "Report").definitions?.Report,
  CreateKeyBody: zodToJsonSchema(CreateKeyBody, "CreateKeyBody").definitions?.CreateKeyBody,
  CreateUploadBody: zodToJsonSchema(CreateUploadBody, "CreateUploadBody").definitions?.CreateUploadBody,
  CreateDatasetBody: zodToJsonSchema(CreateDatasetBody, "CreateDatasetBody").definitions?.CreateDatasetBody,
  IngestDatasetBody: zodToJsonSchema(IngestDatasetBody, "IngestDatasetBody").definitions?.IngestDatasetBody,
  CreateEpisodeBody: zodToJsonSchema(CreateEpisodeBody, "CreateEpisodeBody").definitions?.CreateEpisodeBody,
  RevokeConsentBody: zodToJsonSchema(RevokeConsentBody, "RevokeConsentBody").definitions?.RevokeConsentBody,
  Error: errorSchema,
};

type Auth = "public" | "org" | "verifier" | "wallet_sig";

function op(summary: string, auth: Auth, bodyRef?: string) {
  const security = auth === "public" ? [] : [{ note: auth }];
  const responses: Record<string, unknown> = {
    "501": { description: "not implemented", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    default: { description: "error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  };
  const entry: Record<string, unknown> = { summary, "x-auth": auth, responses };
  if (bodyRef) {
    entry.requestBody = {
      required: true,
      content: { "application/json": { schema: { $ref: `#/components/schemas/${bodyRef}` } } },
    };
  }
  return entry;
}

const paths: Record<string, Record<string, unknown>> = {
  "/v1/orgs/{orgId}/keys": {
    post: op("Create a signing key for an org", "org", "CreateKeyBody"),
    get: op("List signing keys for an org", "public"),
  },
  "/v1/orgs/{orgId}/keys/{keyId}/revoke": { post: op("Revoke a signing key", "org") },
  "/v1/uploads": { post: op("Request an upload", "org", "CreateUploadBody") },
  "/v1/uploads/{hash}": { put: op("Store upload bytes (local store only)", "org") },
  "/v1/datasets": { post: op("Create a dataset", "org", "CreateDatasetBody") },
  "/v1/datasets/{id}/ingest": { post: op("Ingest a dataset", "org", "IngestDatasetBody") },
  "/v1/jobs/{jobId}": { get: op("Get job status", "org") },
  "/v1/episodes": { post: op("Log an episode", "org", "CreateEpisodeBody") },
  "/v1/episodes/{leafHash}": { get: op("Get episode detail", "public") },
  "/v1/proofs/inclusion": { get: op("Get an inclusion proof", "public") },
  "/v1/proofs/consistency": { get: op("Get a consistency proof", "public") },
  "/v1/consent/{consentKey}": { get: op("Get consent status", "public") },
  "/v1/consent/{consentKey}/revoke": { post: op("Revoke consent", "public", "RevokeConsentBody") },
  "/v1/corpora": { post: op("Create a corpus", "org", "CorpusManifest") },
  "/v1/corpora/{id}/log": { post: op("Log a corpus", "org") },
  "/v1/corpora/{id}/seal-params": { get: op("Get seal calldata inputs", "org") },
  "/v1/corpora/{id}": { get: op("Get a corpus", "public") },
  "/v1/corpora/{id}/report": { get: op("Get a corpus report", "public") },
  "/v1/claims": { post: op("Log a verification claim", "verifier", "VerificationClaim") },
  "/v1/anchors": { get: op("List anchors", "public") },
  "/v1/anchors/audit": { get: op("Anchor audit status", "public") },
  "/v1/licences/{receiptId}/download": { get: op("Download licensed files", "wallet_sig") },
  "/v1/healthz": {
    get: {
      summary: "Health check",
      "x-auth": "public",
      responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } } },
    },
  },
};

const doc = {
  openapi: "3.0.3",
  info: { title: "THENAR API", version: "1.0.0", description: "PLAN.md §12 — every route stubbed 501 until its task lands." },
  servers: [{ url: "/v1" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas,
  },
  paths,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "openapi.json");
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${outPath}`);
