import { defaultKeymap, history, historyKeymap, isolateHistory, undo, redo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { controlChange } from "./controls.js";
export { createControlsPanel } from "./controls.js";

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], class: "tok-keyword" },
  { tag: tags.string, class: "tok-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "tok-constant" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.className, tags.typeName], class: "tok-entity" },
  { tag: [tags.variableName, tags.propertyName], class: "tok-variable" },
  { tag: tags.regexp, class: "tok-regexp" },
  { tag: tags.comment, class: "tok-comment" },
]);

export function createEditor(parent, onChange) {
  const access = new Compartment();
  let enabled = false;
  let pendingMeasure = false;
  let forceMeasure = false;
  let measureTimer;
  const accessMode = () => [EditorView.editable.of(enabled), EditorState.readOnly.of(!enabled)];
  const extensions = () => [
    access.of(accessMode()),
    EditorState.tabSize.of(2),
    EditorView.contentAttributes.of({ "aria-label": "Sketch JavaScript", spellcheck: "false" }),
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    javascript(),
    bracketMatching(),
    syntaxHighlighting(highlighting),
    drawSelection(),
    EditorView.updateListener.of(update => {
      if (update.docChanged) onChange();
      if (pendingMeasure && (update.docChanged || update.selectionSet)) scheduleMeasure();
    }),
  ];
  const view = new EditorView({
    state: EditorState.create({ extensions: extensions() }),
    parent,
  });
  const fontMetrics = () => {
    const style = getComputedStyle(view.contentDOM);
    return [style.fontFamily, style.fontSize, style.fontWeight, style.fontStretch, style.fontStyle,
      style.lineHeight, style.letterSpacing, style.fontFeatureSettings, style.fontVariationSettings,
      style.fontVariantLigatures].join("\0");
  };
  let lastMetrics = fontMetrics();
  function scheduleMeasure(force = false) {
    pendingMeasure = true;
    forceMeasure ||= force;
    clearTimeout(measureTimer);
    measureTimer = setTimeout(() => {
      if (view.compositionStarted) return;
      const currentMetrics = fontMetrics();
      if (forceMeasure || currentMetrics !== lastMetrics) {
        const { scrollTop, scrollLeft } = view.scrollDOM;
        // requestMeasure alone does not invalidate CodeMirror's cached font metrics.
        view.setState(view.state);
        view.scrollDOM.scrollTop = scrollTop;
        view.scrollDOM.scrollLeft = scrollLeft;
        lastMetrics = currentMetrics;
      }
      pendingMeasure = false;
      forceMeasure = false;
      view.requestMeasure();
    }, 120);
  }
  const themeObserver = new MutationObserver(() => scheduleMeasure());
  const attributes = ["class", "style", "data-color-mode", "data-dark-theme", "data-light-theme",
    "data-theme-source", "data-theme-tone", "data-visual-mode"];
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: attributes });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: attributes });
  themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["media", "disabled"] });
  view.contentDOM.addEventListener("compositionend", () => { if (pendingMeasure) scheduleMeasure(); });
  if (document.fonts) {
    document.fonts.ready.then(() => scheduleMeasure(true));
    document.fonts.addEventListener("loadingdone", () => scheduleMeasure(true));
  }

  return {
    focus: () => view.focus(),
    getValue: () => view.state.doc.toString(),
    undo: () => enabled && undo(view),
    redo: () => enabled && redo(view),
    changeControl(source, control, value) {
      if (!enabled || view.state.doc.toString() !== source) throw new Error("The source changed. Use the refreshed controls.");
      const changes = controlChange(source, control, value);
      view.dispatch({ changes, userEvent: "input.control",
        annotations: [Transaction.addToHistory.of(true), isolateHistory.of("full")] });
    },
    setValue(value) {
      const { anchor, head } = view.state.selection.main;
      const scrollTop = view.scrollDOM.scrollTop;
      const scrollLeft = view.scrollDOM.scrollLeft;
      view.setState(EditorState.create({
        doc: value,
        selection: EditorSelection.single(Math.min(anchor, value.length), Math.min(head, value.length)),
        extensions: extensions(),
      }));
      view.scrollDOM.scrollTop = scrollTop;
      view.scrollDOM.scrollLeft = scrollLeft;
    },
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      view.dispatch({ effects: access.reconfigure(accessMode()) });
    },
  };
}
