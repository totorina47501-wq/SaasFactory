export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type DeepReadonly<T> = T extends (...args: infer Arguments) => infer Result
  ? (...args: Arguments) => DeepReadonly<Result>
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ModuleMaturity = 'reference' | 'scaffold' | 'implemented' | 'verified';
export type ModuleCategory = 'identity' | 'storage' | 'jobs' | 'audit' | 'entitlements' | 'ai' | 'media' | 'api' | 'other';

export interface VerificationEvidence {
  kind: 'test' | 'review' | 'ci' | 'measurement';
  reference: string;
  version: string;
  scope: 'implementation' | 'isolation' | 'generation' | 'migration' | 'security' | 'hardware';
}

export interface ConfigurationProperty {
  type: 'string' | 'boolean' | 'number' | 'integer' | 'enum';
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface ModuleDescriptor {
  contractVersion: 1;
  id: string;
  version: string;
  description: string;
  category: ModuleCategory;
  maturity: ModuleMaturity;
  prerequisites: string[];
  dependencies: string[];
  incompatibilities: string[];
  configuration: {
    schemaVersion: 1;
    type: 'object';
    additionalProperties: false;
    required: string[];
    properties: Record<string, ConfigurationProperty>;
  };
  permissions: string[];
  generatedFiles: string[];
  tests: string[];
  hardware: { cpuCores?: number; memoryMiB?: number; diskMiB?: number };
  security: {
    dataClassification: 'public' | 'tenant' | 'sensitive';
    handlesSecrets: boolean;
    permissionsReviewed: boolean;
  };
  offline: { supported: boolean; networkRequired: boolean };
  update: string;
  rollback: string;
  verification?: VerificationEvidence[];
}

export interface TenantContext {
  contractVersion: 1;
  tenantId: string;
  requestId: string;
}

export type ContractErrorCode = 'UNKNOWN_FIELD' | 'INVALID_VERSION' | 'INVALID_INPUT';
export class ContractError extends Error {
  readonly code: ContractErrorCode;
}

export const CONTRACT_VERSION: 1;
export function validateModuleDescriptor(value: unknown): DeepReadonly<ModuleDescriptor>;
export function assertTenantContext(value: unknown): Readonly<TenantContext>;

export interface LocalStorage {
  get(context: TenantContext, key: string): Promise<{ value: JsonValue; version: number } | undefined>;
  put(context: TenantContext, key: string, value: JsonValue, expectedVersion?: number): Promise<number>;
  delete(context: TenantContext, key: string, expectedVersion?: number): Promise<boolean>;
}

export interface JobInput {
  type: string;
  payload: JsonValue;
  maxAttempts?: number;
}
export interface QueuedJob extends JobInput {
  id: string;
  tenantId: string;
  attempts: number;
  createdAt: string;
}
export interface JobQueue {
  enqueue(context: TenantContext, job: JobInput): Promise<{ jobId: string }>;
  claim(context: TenantContext, workerId: string, leaseMs: number): Promise<QueuedJob | undefined>;
  complete(context: TenantContext, jobId: string, result?: JsonValue): Promise<void>;
  fail(context: TenantContext, jobId: string, failure: { code: string; message: string; retryable: boolean }): Promise<void>;
}

export interface AuditEvent {
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome: 'success' | 'denied' | 'failure';
  details?: JsonValue;
}
export interface AuditSink {
  append(context: TenantContext, event: AuditEvent): Promise<{ eventId: string; recordedAt: string }>;
}

export interface EntitlementProvider {
  check(context: TenantContext, featureId: string): Promise<{
    allowed: boolean;
    reason?: 'granted' | 'disabled' | 'limit-reached' | 'unknown';
    limits?: Record<string, number>;
  }>;
}

export interface LocalModelRequest {
  input: string;
  maxOutputTokens: number;
}
export interface LocalModelResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}
export interface LocalModelAdapter {
  generate(context: TenantContext, request: LocalModelRequest): Promise<LocalModelResult>;
}
