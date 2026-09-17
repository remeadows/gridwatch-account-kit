// The two player prompts from spec §3.3 / §5.4. Plain DOM, styles in header.css (games CSP
// forbids inline styles). One dialog at a time; identical concurrent asks share the answer.
export interface PromptCopy { text: string; primary: string; secondary: string }
export type PromptAnswer = "primary" | "secondary";
export interface PromptHost { ask(copy: PromptCopy): Promise<PromptAnswer> }

export const CONFLICT_COPY: PromptCopy = Object.freeze({
  text: "Newer save in the cloud from another device. Use cloud or keep this one?",
  primary: "Use cloud",
  secondary: "Keep this one",
});

export const OWNERSHIP_COPY: PromptCopy = Object.freeze({
  text: "This device has progress from another account. Upload it to this account, or start fresh?",
  primary: "Upload",
  secondary: "Start fresh",
});

function button(doc: Document, className: string, label: string): HTMLButtonElement {
  const node = doc.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  return node;
}

function show(doc: Document, copy: PromptCopy): Promise<PromptAnswer> {
  return new Promise((resolve) => {
    const dialog = doc.createElement("dialog");
    dialog.className = "gw-save-prompt";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    const text = doc.createElement("p");
    text.className = "gw-save-prompt__text";
    text.textContent = copy.text;
    const actions = doc.createElement("div");
    actions.className = "gw-save-prompt__actions";
    const primary = button(doc, "gw-save-prompt__primary", copy.primary);
    primary.autofocus = true;
    const secondary = button(doc, "gw-save-prompt__secondary", copy.secondary);
    actions.append(primary, secondary);
    dialog.append(text, actions);
    dialog.addEventListener("cancel", (event) => event.preventDefault()); // Escape must not dismiss
    const finish = (answer: PromptAnswer) => {
      if (typeof dialog.close === "function") dialog.close();
      dialog.remove();
      resolve(answer);
    };
    primary.addEventListener("click", () => finish("primary"));
    secondary.addEventListener("click", () => finish("secondary"));
    doc.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  });
}

/** `doc` is resolved when a prompt is first shown, so the host can be created where there is no DOM yet. */
export function createDomPromptHost(doc?: Document): PromptHost {
  let queue: Promise<unknown> = Promise.resolve();
  let pending: { copy: PromptCopy; answer: Promise<PromptAnswer> } | null = null;
  return {
    ask(copy) {
      if (pending && pending.copy.text === copy.text) return pending.answer;
      const answer = queue.then(() => show(doc ?? document, copy));
      const entry = { copy, answer };
      pending = entry;
      queue = answer.finally(() => { if (pending === entry) pending = null; });
      return answer;
    },
  };
}
