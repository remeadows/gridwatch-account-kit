// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CONFLICT_COPY, OWNERSHIP_COPY, createDomPromptHost } from "../src/saves/prompt";

const tick = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => { document.body.innerHTML = ""; });

describe("prompt copy", () => {
  it("is the spec copy verbatim", () => {
    expect(CONFLICT_COPY).toEqual({ text: "Newer save in the cloud from another device. Use cloud or keep this one?", primary: "Use cloud", secondary: "Keep this one" });
    expect(OWNERSHIP_COPY).toEqual({ text: "This device has progress from another account. Upload it to this account, or start fresh?", primary: "Upload", secondary: "Start fresh" });
  });
});

describe("createDomPromptHost", () => {
  it("renders one dialog with the contract and resolves the clicked answer", async () => {
    const host = createDomPromptHost();
    const pending = host.ask(CONFLICT_COPY);
    await tick();
    const dialog = document.querySelector("dialog.gw-save-prompt")!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector(".gw-save-prompt__text")!.textContent).toBe(CONFLICT_COPY.text);
    expect(dialog.querySelector(".gw-save-prompt__primary")!.textContent).toBe("Use cloud");
    expect(dialog.querySelector(".gw-save-prompt__secondary")!.textContent).toBe("Keep this one");
    expect(dialog.querySelector("[style]")).toBeNull();
    (dialog.querySelector(".gw-save-prompt__primary") as HTMLButtonElement).click();
    expect(await pending).toBe("primary");
    expect(document.querySelector("dialog.gw-save-prompt")).toBeNull();
  });
  it("shares one answer between concurrent asks with the same copy", async () => {
    const host = createDomPromptHost();
    const a = host.ask(CONFLICT_COPY);
    const b = host.ask(CONFLICT_COPY);
    await tick();
    expect(document.querySelectorAll("dialog.gw-save-prompt").length).toBe(1);
    (document.querySelector(".gw-save-prompt__secondary") as HTMLButtonElement).click();
    expect(await Promise.all([a, b])).toEqual(["secondary", "secondary"]);
  });
  it("queues a different copy behind the open one", async () => {
    const host = createDomPromptHost();
    const first = host.ask(CONFLICT_COPY);
    const second = host.ask(OWNERSHIP_COPY);
    await tick();
    expect(document.querySelectorAll("dialog.gw-save-prompt").length).toBe(1);
    expect(document.querySelector(".gw-save-prompt__text")!.textContent).toBe(CONFLICT_COPY.text);
    (document.querySelector(".gw-save-prompt__primary") as HTMLButtonElement).click();
    expect(await first).toBe("primary");
    await tick();
    expect(document.querySelector(".gw-save-prompt__text")!.textContent).toBe(OWNERSHIP_COPY.text);
    (document.querySelector(".gw-save-prompt__primary") as HTMLButtonElement).click();
    expect(await second).toBe("primary");
  });
  it("cannot be dismissed without answering (Escape is swallowed)", async () => {
    const host = createDomPromptHost();
    const pending = host.ask(CONFLICT_COPY);
    await tick();
    const dialog = document.querySelector("dialog.gw-save-prompt")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await tick();
    expect(document.querySelector("dialog.gw-save-prompt")).not.toBeNull();
    (dialog.querySelector(".gw-save-prompt__secondary") as HTMLButtonElement).click();
    expect(await pending).toBe("secondary");
  });
  it("shares the answer with a same-copy ask even when a different copy is queued in between", async () => {
    const host = createDomPromptHost();
    const a = host.ask(CONFLICT_COPY);
    const b = host.ask(OWNERSHIP_COPY);
    const c = host.ask(CONFLICT_COPY);
    await tick();
    expect(document.querySelectorAll("dialog.gw-save-prompt").length).toBe(1);
    (document.querySelector(".gw-save-prompt__secondary") as HTMLButtonElement).click();
    expect(await Promise.all([a, c])).toEqual(["secondary", "secondary"]);
    await tick();
    expect(document.querySelectorAll("dialog.gw-save-prompt").length).toBe(1);
    expect(document.querySelector(".gw-save-prompt__text")!.textContent).toBe(OWNERSHIP_COPY.text);
    (document.querySelector(".gw-save-prompt__primary") as HTMLButtonElement).click();
    expect(await b).toBe("primary");
    expect(document.querySelector("dialog.gw-save-prompt")).toBeNull();
  });
});

describe("dispose", () => {
  it("closes the open dialog and rejects the pending ask, then a fresh ask afterwards still works", async () => {
    const host = createDomPromptHost();
    const pending = host.ask(CONFLICT_COPY);
    await tick();
    expect(document.querySelector("dialog.gw-save-prompt")).not.toBeNull();

    host.dispose();
    await expect(pending).rejects.toThrow("disposed");
    expect(document.querySelector("dialog.gw-save-prompt")).toBeNull();

    const next = host.ask(OWNERSHIP_COPY);
    await tick();
    const dialog = document.querySelector("dialog.gw-save-prompt")!;
    expect(dialog.querySelector(".gw-save-prompt__text")!.textContent).toBe(OWNERSHIP_COPY.text);
    (dialog.querySelector(".gw-save-prompt__primary") as HTMLButtonElement).click();
    expect(await next).toBe("primary");
  });
  it("rejects every pending ask, including ones still queued behind the open dialog", async () => {
    const host = createDomPromptHost();
    const first = host.ask(CONFLICT_COPY);
    const second = host.ask(OWNERSHIP_COPY);
    await tick();
    host.dispose();
    await expect(first).rejects.toThrow("disposed");
    await expect(second).rejects.toThrow("disposed");
  });
});
