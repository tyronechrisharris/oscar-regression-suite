import assert from "node:assert/strict";
import test from "node:test";
import {csvCell, toCsv} from "../src/csv.js";

test("csvCell quotes commas, quotes, and line breaks", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell("a\nb"), '"a\nb"');
  assert.equal(csvCell(null), "");
});

test("toCsv emits stable requested columns and a trailing newline", () => {
  const csv = toCsv([{name: "lane,1", passed: true}], ["name", "passed"]);
  assert.equal(csv, 'name,passed\n"lane,1",true\n');
});
