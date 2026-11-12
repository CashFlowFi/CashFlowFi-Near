// Every refusal is a RelayError carrying the HTTP status the handler returns.
export class RelayError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
export const reject = (code, detail) => new RelayError(403, code, detail);
export const malformed = (code, detail) => new RelayError(400, code, detail);
