export class SelfError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function ensure(ok, code, status = 400) {
  if (!ok) throw new SelfError(code, status);
}
export function publicError(error) {
  return {
    ok: false,
    code: error instanceof SelfError ? error.code : "INTERNAL_ERROR",
    message: "操作を完了できませんでした。状態を確認してやり直してください。",
    requestId: crypto.randomUUID(),
  };
}
