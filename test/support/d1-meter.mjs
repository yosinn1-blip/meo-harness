// Counts D1 work per scheduled invocation: every binding call (prepare().run/
// first/all/raw and each batch) and every SQL statement, counting each
// statement inside a batch separately (the conservative Free-plan reading).
export function meterD1(db, failBatch = () => false) {
  const stats = { calls: 0, statements: 0 };
  const original = new WeakMap();
  function wrap(stmt) {
    const out = { bind: (...args) => wrap(stmt.bind(...args)) };
    for (const method of ["first", "all", "run", "raw"])
      out[method] = (...args) => {
        stats.calls++;
        stats.statements++;
        return stmt[method](...args);
      };
    original.set(out, stmt);
    return out;
  }
  return {
    stats,
    db: {
      prepare: (sql) => wrap(db.prepare(sql)),
      batch: (statements) => {
        stats.calls++;
        stats.statements += statements.length;
        if (failBatch()) throw Error("fixture storage unavailable");
        return db.batch(statements.map((s) => original.get(s) ?? s));
      },
    },
  };
}
