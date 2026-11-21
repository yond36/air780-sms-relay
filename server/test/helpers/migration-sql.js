// Split trusted repository migrations without splitting trigger BEGIN/END bodies.
// This is fixture tooling, not a parser for administrator-supplied SQL.
export function splitMigrationSql(source) {
  const statements = [];
  let sql = "", word = "", words = [], quote = null, comment = null, trigger = false, depth = 0;
  function finishWord() {
    if (!word) return;
    const token = word.toUpperCase();
    words.push(token);
    if (words[0] === "CREATE" && (words[1] === "TRIGGER"
      || ["TEMP", "TEMPORARY"].includes(words[1]) && words[2] === "TRIGGER")) trigger = true;
    if (trigger) {
      if (token === "BEGIN" || token === "CASE") depth++;
      else if (token === "END") depth--;
      if (depth < 0) throw new Error("Unbalanced migration trigger");
    }
    word = "";
  }
  function finishStatement() {
    if (sql.trim()) statements.push(sql.trim());
    sql = ""; word = ""; words = []; trigger = false; depth = 0;
  }
  for (let index = 0; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (comment === "line") {
      if (char === "\n") { comment = null; sql += "\n"; }
      continue;
    }
    if (comment === "block") {
      if (char === "*" && next === "/") { comment = null; index++; }
      continue;
    }
    if (quote) {
      sql += char;
      if (char === quote) {
        if (next === quote && quote !== "]") { sql += next; index++; }
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-" || char === "/" && next === "*") {
      finishWord(); sql += " "; comment = char === "-" ? "line" : "block"; index++; continue;
    }
    if (["'", '"', "`", "["].includes(char)) {
      finishWord(); quote = char === "[" ? "]" : char; sql += char; continue;
    }
    if (/[A-Za-z0-9_]/.test(char)) { word += char; sql += char; continue; }
    finishWord();
    if (char === ";" && (!trigger || depth === 0)) finishStatement();
    else sql += char;
  }
  finishWord();
  if (quote || comment === "block" || depth !== 0) throw new Error("Incomplete repository migration");
  finishStatement();
  return statements;
}
