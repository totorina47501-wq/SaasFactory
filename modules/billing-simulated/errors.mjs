export class BillingModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BillingModuleError';
    this.code = code;
  }
}

export function fail(code) {
  throw new BillingModuleError(code);
}
