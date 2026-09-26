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
