import { javascriptLanguage } from "@codemirror/lang-javascript";

function stringValue(raw) {
  let value = "";
  for (let i = 1; i < raw.length - 1; i++) {
    let c = raw[i];
    if (c !== "\\") { value += c; continue; }
    c = raw[++i];
    const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"' };
    if (Object.hasOwn(simple, c)) value += simple[c];
    else if (c === "\n") continue;
    else if (c === "\r") { if (raw[i + 1] === "\n") i++; }
    else if (c === "0" && !/\d/.test(raw[i + 1])) value += "\0";
    else if (c === "x" || c === "u") {
      const rest = raw.slice(i + 1);
      const match = c === "x" ? /^[\da-f]{2}/i.exec(rest)
        : /^(?:[\da-f]{4}|\{[\da-f]{1,6}\})/i.exec(rest);
      if (!match) return;
      const point = parseInt(match[0].replace(/[{}]/g, ""), 16);
      if (point > 0x10ffff) return;
      value += String.fromCodePoint(point);
      i += match[0].length;
    } else if (/\d/.test(c)) return;
    else value += c;
  }
  return value;
}

function literal(node, source) {
  const raw = source.slice(node.from, node.to);
  if (node.name === "String") {
    const value = stringValue(raw);
    if (value !== undefined) return { type: /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? "color" : "text", value };
  }
  if (node.name === "BooleanLiteral") return { type: "boolean", value: raw === "true" };
  if (node.name === "Number" || (node.name === "UnaryExpression" && /^[+-]/.test(raw))) {
    if (!/^[+-]?(?:0[xob][\da-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?[\d_]+)?)$/i.test(raw)) return;
    const digits = raw.replace(/^[+-]/, "").replaceAll("_", "");
    if (/^0\d/.test(digits)) return;
    const value = (raw.startsWith("-") ? -1 : 1) * Number(digits);
    if (Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return { type: "number", value };
  }
}

function commentText(node, source) {
  return source.slice(node.from, node.to).replace(/^\/\/|^\/\*|\*\/$/g, "").replace(/^\s*\* ?/gm, "").trim();
}

export function discoverControls(source) {
  const tree = javascriptLanguage.parser.parse(source);
  let invalid = false;
  tree.iterate({ enter(node) { if (node.type.isError) invalid = true; } });
  if (invalid) return { controls: [], message: "Finish the JavaScript syntax to enable controls." };
  const controls = [];
  let unsupported = 0;
  for (let declaration = tree.topNode.firstChild; declaration; declaration = declaration.nextSibling) {
    if (declaration.name !== "VariableDeclaration" || declaration.firstChild?.name !== "const") continue;
    let comment = "";
    const previous = declaration.prevSibling;
    const next = declaration.nextSibling;
    if (previous && /Comment$/.test(previous.name) && /^\s*$/.test(source.slice(previous.to, declaration.from)) &&
        !/\n\s*\n/.test(source.slice(previous.to, declaration.from)) &&
        /^\s*$/.test(source.slice(source.lastIndexOf("\n", previous.from - 1) + 1, previous.from))) comment = commentText(previous, source);
    if (next && /Comment$/.test(next.name) && /^[ \t]*$/.test(source.slice(declaration.to, next.from))) comment = commentText(next, source);
    const rangeMatch = /@range\s+(\S+)\s+(\S+)\s+(\S+)/.exec(comment);
    const hint = rangeMatch && rangeMatch.slice(1).map(Number);
    const range = hint && hint.every(Number.isFinite) && hint[0] < hint[1] && hint[2] > 0 &&
      Number.isFinite(hint[1] - hint[0]) ? { min: hint[0], max: hint[1], step: hint[2] } : null;
    const description = comment.replace(/@range\b[^\n]*/g, "").trim();
    for (let node = declaration.firstChild?.nextSibling; node; node = node.nextSibling) {
      if (node.name !== "VariableDefinition") continue;
      const equals = node.nextSibling;
      const initializer = equals?.name === "Equals" ? equals.nextSibling : null;
      const value = initializer && literal(initializer, source);
      if (!value) { unsupported++; continue; }
      const name = source.slice(node.from, node.to);
      const label = description || name.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_$]+/g, " ").toLowerCase().replace(/^./, c => c.toUpperCase());
      controls.push({ name, label, from: initializer.from, to: initializer.to, ...value,
        range: value.type === "number" ? range : null });
    }
  }
  return { controls, message: unsupported ? `${unsupported} unsupported initializer(s) omitted. Only top-level const literals are editable.` :
    controls.length ? "Edits update the source, preview and saved sketch." : "No top-level const scalar literals found." };
}

const kind = type => type === "color" ? "text" : type;

export function controlChange(source, control, value) {
  const current = discoverControls(source).controls.find(item => item.from === control.from && item.to === control.to &&
    item.name === control.name && kind(item.type) === kind(control.type));
  if (!current) throw new Error("This control is no longer available. Use the current source.");
  let insert;
  if (current.type === "number") {
    if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw new Error("Enter a complete finite number.");
    const number = Number(value);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) throw new Error("Enter a finite number within safe numeric precision.");
    if (current.range && (number < current.range.min || number > current.range.max)) throw new Error("Enter a number within the annotated range.");
    insert = Object.is(number, -0) ? "-0" : String(number);
  } else if (current.type === "boolean") {
    if (typeof value !== "boolean") throw new Error("Expected a boolean.");
    insert = String(value);
  } else {
    if (typeof value !== "string") throw new Error("Expected text.");
    const quote = source[current.from];
    insert = JSON.stringify(value);
    if (quote === "'") insert = "'" + insert.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
  }
  return { from: current.from, to: current.to, insert };
}

export function createControlsPanel(parent, message, change) {
  let bindings = [];
  let signature;
  let last;
  const panel = {
    render(source, enabled) {
      last = [source, enabled];
      const model = discoverControls(source);
      message.textContent = model.message;
      // A text field being typed into stays text even if its value briefly looks like a color.
      const ui = (control, index) => control.type === "color" && bindings[index]?.ui === "text" &&
        bindings[index].inputs.includes(document.activeElement) ? "text" : control.type;
      const key = JSON.stringify([enabled, model.controls.map((c, i) => [c.name, ui(c, i), c.label, c.range])]);
      if (signature !== key) {
        signature = key;
        const types = model.controls.map(ui);
        bindings = model.controls.map((control, index) => {
          const row = document.createElement("label");
          row.className = "parameter";
          const title = document.createElement("span");
          title.textContent = control.label;
          const name = document.createElement("small");
          name.textContent = control.name;
          row.append(title, name);
          const inputs = [];
          for (const type of control.type === "number" && control.range ? ["range", "number"] :
            [({ boolean: "checkbox", number: "number", color: "color", text: "text" })[types[index]]]) {
            const input = document.createElement(type === "text" ? "textarea" : "input");
            if (type !== "text") input.type = type;
            else input.rows = 2;
            input.setAttribute("aria-label", `${control.label}${type === "range" ? " slider" : ""}`);
            if (type === "checkbox") input.setAttribute("role", "switch");
            if (control.type === "number") {
              input.step = control.range?.step ?? "any";
              if (control.range) { input.min = control.range.min; input.max = control.range.max; }
            }
            inputs.push(input);
            row.append(input);
          }
          const binding = { inputs, control, source, enabled, row, ui: types[index] };
          for (const input of inputs) input.addEventListener("input", () => {
            if (!binding.enabled || !parent.contains(input)) return;
            try {
              change(binding.source, binding.control, input.type === "checkbox" ? input.checked : input.value);
              input.setCustomValidity("");
            } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
          });
          if (binding.ui === "text") inputs[0].addEventListener("blur", () => {
            if (binding.control.type === "color") queueMicrotask(() => panel.render(...last));
          });
          return binding;
        });
        parent.replaceChildren(...bindings.map(binding => binding.row));
      }
      bindings.forEach((binding, index) => {
        binding.control = model.controls[index];
        binding.source = source;
        binding.enabled = enabled;
        for (const input of binding.inputs) {
          const value = binding.control.value;
          const range = binding.control.range;
          const steps = range && (value - range.min) / range.step;
          const outsideRange = input.type === "range" && (value < range.min || value > range.max ||
            !Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > 1e-8);
          input.disabled = !enabled || outsideRange;
          input.title = outsideRange ? "The source value is outside this slider's range or step. Edit the number or source first." : "";
          if (input.type === "checkbox") input.checked = value;
          else {
            const display = input.type === "color" && value.length === 4 ? "#" + [...value.slice(1)].map(c => c + c).join("") :
              Object.is(value, -0) ? "-0" : String(value);
            // Keep in-progress spellings such as "0.10" while the user types an equivalent number.
            const typing = input.type === "number" && input === document.activeElement &&
              input.value !== "" && Object.is(Number(input.value), value);
            if (input.value !== display && !typing) input.value = display;
          }
        }
      });
    },
  };
  return panel;
}
