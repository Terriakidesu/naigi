function createDialog(title: string, description: string) {
  const dialog = document.createElement("dialog");
  dialog.className = "app-dialog";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = description;
  dialog.append(heading, hint);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  return dialog;
}

let externalDialogId = 0;

export function promptUnsavedChanges() {
  return new Promise<"save" | "discard" | "stay">((resolve) => {
    const dialog = createDialog("Unsaved changes", "Save your changes before leaving, discard them, or stay here to keep editing.");
    const heading = dialog.querySelector("h2")!;
    heading.id = `unsaved-changes-title-${++externalDialogId}`;
    dialog.setAttribute("aria-labelledby", heading.id);
    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    let choice: "save" | "discard" | "stay" = "stay";
    for (const [value, label] of [["stay", "Stay here"], ["discard", "Discard changes"], ["save", "Save changes"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (value !== "save") button.className = "secondary";
      button.addEventListener("click", () => { choice = value; dialog.close(); });
      actions.append(button);
    }
    dialog.append(actions);
    dialog.addEventListener("close", () => resolve(choice), { once: true });
    dialog.showModal();
    actions.querySelector("button")!.focus();
  });
}

export function confirmExternalUrl(url: URL, mode: "link" | "media" = "link") {
  return new Promise<boolean>((resolve) => {
    const dialog = createDialog(
      mode === "link" ? "You’re leaving Naigi" : "Play external video?",
      mode === "link"
        ? "This link opens an external website. Check the destination before continuing."
        : "This video is hosted outside Naigi and will load from the destination below.",
    );
    dialog.classList.add("external-link-dialog");
    const heading = dialog.querySelector("h2")!;
    const hint = dialog.querySelector("p.muted")!;
    heading.id = `external-link-dialog-title-${++externalDialogId}`;
    hint.id = `${heading.id}-description`;
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", hint.id);
    const mark = document.createElement("span");
    mark.className = "external-link-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "↗";
    heading.prepend(mark);

    const destination = document.createElement("section");
    destination.className = "external-link-destination";
    const label = document.createElement("span");
    label.className = "external-link-destination-label";
    label.textContent = "External destination";
    const host = document.createElement("strong");
    host.className = "external-link-host";
    host.textContent = url.host;
    const address = document.createElement("code");
    address.className = "external-link-address";
    address.textContent = url.href;
    destination.append(label, host, address);

    const warning = document.createElement("p");
    warning.className = "external-link-warning";
    warning.textContent = "External websites may collect information about your visit or playback. Only continue if you trust this destination.";

    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    const cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = mode === "link" ? "Open link" : "Play video";
    actions.append(cancel, open);
    dialog.append(destination, warning, actions);

    let approved = false;
    cancel.addEventListener("click", () => dialog.close());
    open.addEventListener("click", () => {
      approved = true;
      dialog.close();
    });
    dialog.addEventListener("close", () => resolve(approved), { once: true });
    dialog.showModal();
    cancel.focus();
  });
}

export function askText(title: string, description: string, label: string, initialValue = "") {
  return new Promise<string | null>((resolve) => {
    const dialog = createDialog(title, description);
    const form = document.createElement("form");
    const inputLabel = document.createElement("label");
    inputLabel.textContent = label;
    const input = document.createElement("input");
    input.required = true;
    input.maxLength = label === "Invite token" ? 256 : 80;
    input.value = initialValue;
    input.autocomplete = "off";
    inputLabel.append(input);
    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    const cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => dialog.close());
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = label === "Invite token" ? "Join server" : "Continue";
    actions.append(cancel, submit);
    form.append(inputLabel, actions);
    dialog.append(form);
    let answer: string | null = null;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      answer = input.value.trim();
      if (answer) dialog.close();
    });
    dialog.addEventListener("close", () => resolve(answer), { once: true });
    dialog.showModal();
    input.focus();
    input.select();
  });
}

export function showOneTimeToken(token: string) {
  return new Promise<void>((resolve) => {
    const dialog = createDialog("Invite created", "Copy this token now. It will not be shown again; share it privately with the person you want to invite.");
    const field = document.createElement("textarea");
    field.readOnly = true;
    field.rows = 3;
    field.value = token;
    field.setAttribute("aria-label", "Invite token");
    const feedback = document.createElement("p");
    feedback.className = "form-status";
    feedback.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy token";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(field.value);
        feedback.textContent = "Copied to clipboard.";
      } catch {
        field.focus();
        field.select();
        feedback.textContent = "Select and copy the token manually.";
      }
    });
    const done = document.createElement("button");
    done.className = "secondary";
    done.type = "button";
    done.textContent = "Done";
    done.addEventListener("click", () => dialog.close());
    actions.append(done, copy);
    dialog.append(field, feedback, actions);
    dialog.addEventListener("close", () => {
      field.value = "";
      resolve();
    }, { once: true });
    dialog.showModal();
    copy.focus();
  });
}
