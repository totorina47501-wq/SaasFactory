export class EntitlementsModuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EntitlementsModuleError';
    this.code = code;
  }
}

export function fail(code) {
  throw new EntitlementsModuleError(code);
}
