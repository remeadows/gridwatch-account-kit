export const CONFLICT_COPY = Object.freeze({
    text: "Newer save in the cloud from another device. Use cloud or keep this one?",
    primary: "Use cloud",
    secondary: "Keep this one",
});
export const OWNERSHIP_COPY = Object.freeze({
    text: "This device has progress from another account. Upload it to this account, or start fresh?",
    primary: "Upload",
    secondary: "Start fresh",
});
export const REPLACE_COPY = Object.freeze({
    text: "Replace the progress on this site with your progress from the old site?",
    primary: "Replace",
    secondary: "Keep this site's",
});
function button(doc, className, label) {
    const node = doc.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    return node;
}
/** `doc` is resolved when a prompt is first shown, so the host can be created where there is no DOM yet. */
export function createDomPromptHost(doc) {
    let queue = Promise.resolve();
    const pending = new Map();
    let openDialog = null;
    function show(copy) {
        return new Promise((resolve) => {
            const d = doc ?? document;
            const dialog = d.createElement("dialog");
            dialog.className = "gw-save-prompt";
            dialog.setAttribute("role", "alertdialog");
            dialog.setAttribute("aria-modal", "true");
            const text = d.createElement("p");
            text.className = "gw-save-prompt__text";
            text.textContent = copy.text;
            const actions = d.createElement("div");
            actions.className = "gw-save-prompt__actions";
            const primary = button(d, "gw-save-prompt__primary", copy.primary);
            primary.autofocus = true;
            const secondary = button(d, "gw-save-prompt__secondary", copy.secondary);
            actions.append(primary, secondary);
            dialog.append(text, actions);
            dialog.addEventListener("cancel", (event) => event.preventDefault()); // Escape must not dismiss
            const finish = (answer) => {
                if (typeof dialog.close === "function")
                    dialog.close();
                dialog.remove();
                if (openDialog === dialog)
                    openDialog = null;
                resolve(answer);
            };
            primary.addEventListener("click", () => finish("primary"));
            secondary.addEventListener("click", () => finish("secondary"));
            d.body.append(dialog);
            openDialog = dialog;
            if (typeof dialog.showModal === "function")
                dialog.showModal();
            else
                dialog.setAttribute("open", "");
        });
    }
    return {
        ask(copy) {
            const existing = pending.get(copy.text);
            if (existing)
                return existing.promise;
            let reject;
            const promise = new Promise((resolve, rej) => {
                reject = rej;
                const answer = queue.then(() => show(copy));
                answer.then(resolve, rej);
                // The queue advances even if show() throws or this ask is later rejected by dispose(),
                // so one bad prompt can never permanently wedge every ask after it.
                queue = answer.catch(() => undefined).finally(() => { pending.delete(copy.text); });
            });
            pending.set(copy.text, { promise, reject });
            return promise;
        },
        dispose() {
            if (openDialog) {
                const dialog = openDialog;
                openDialog = null;
                if (typeof dialog.close === "function")
                    dialog.close();
                dialog.remove();
            }
            for (const entry of pending.values())
                entry.reject(new Error("disposed"));
            pending.clear();
            queue = Promise.resolve();
        },
    };
}
