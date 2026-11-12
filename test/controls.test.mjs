import assert from "node:assert/strict";
import test from "node:test";
import { controlChange, discoverControls } from "../extension/controls.js";

test("discovers only static top-level scalar const initializers without evaluation", () => {
  const source = `// Orbital speed @range -2 5 0.1
const ORBIT_SPEED = -1.5;
const COUNT = 0xff, enabled = true, title = 'Hello\\nworld', ink = "#abc";
const NEGATIVE_HEX = -0xff;
let mutable = 4;
const object = {}, array = [], computed = 2 * 3, called = dangerous(), template = \`hi\`, big = 2n;
function setup() { const local = 1; }
const unsafe = 9007199254740993;
`;
  const { controls, message } = discoverControls(source);
  assert.deepEqual(controls.map(c => [c.name, c.type, c.value]), [
    ["ORBIT_SPEED", "number", -1.5], ["COUNT", "number", 255], ["enabled", "boolean", true],
    ["title", "text", "Hello\nworld"], ["ink", "color", "#abc"], ["NEGATIVE_HEX", "number", -255],
  ]);
  assert.equal(controls[0].label, "Orbital speed");
  assert.deepEqual(controls[0].range, { min: -2, max: 5, step: 0.1 });
  assert.match(message, /7 unsupported/);
  assert.equal(discoverControls('const A = 1;\nconst B = "').controls.length, 0);
  assert.equal(discoverControls("const removed = ;").controls.length, 0);
  assert.equal(discoverControls("const legacy = 012;").controls.length, 0);
});

test("initializer replacements preserve source and safely round-trip strings and numbers", () => {
  for (const raw of ["'hello'", '"hello"', "'\\u{1f600}\\x20\\u0041'", "'a\\\nb'"]) {
    let source = `// greeting\nconst greeting = ${raw}; // preserved\n`;
    const control = discoverControls(source).controls[0];
    for (const value of ["a'\"\\\n\t\0", "${notExecuted}", "text\u2028next", ""]) {
      const change = controlChange(source, control, value);
      const next = source.slice(0, change.from) + change.insert + source.slice(change.to);
      assert.equal(discoverControls(next).controls[0].value, value);
      assert.ok(next.endsWith("; // preserved\n"));
      assert.equal(next[change.from], raw[0]);
    }
  }
  const source = "const speed = -0;";
  const control = discoverControls(source).controls[0];
  assert.equal(controlChange(source, control, "1e-7").insert, "1e-7");
  assert.equal(controlChange(source, control, "-0").insert, "-0");
  for (const invalid of ["", "-", "1e", "Infinity", "0x10", "9007199254740993", "1e999"]) {
    assert.throws(() => controlChange(source, control, invalid));
  }
  assert.throws(() => controlChange("const speed = fn();", control, "2"), /no longer/);
});

test("range hints require explicit valid bounds and keep out-of-range source unchanged", () => {
  for (const hint of ["", "@range 5 1 1", "@range 0 10 0", "@range 0 Infinity 1", "@range 0 10 nope"]) {
    assert.equal(discoverControls(`// ${hint}\nconst RATE = 3;`).controls[0].range, null);
  }
  const source = "const RATE = 20; // Rate @range 0 10 0.5";
  const control = discoverControls(source).controls[0];
  assert.equal(control.value, 20);
  assert.equal(control.label, "Rate");
  assert.throws(() => controlChange(source, control, "11"), /range/);
  assert.equal(controlChange(source, control, "2.5").insert, "2.5");
});
