import { iconElement, renderIcons } from "./icons";

export type NewRoom = { name: string; kind: "text" | "voice"; categoryId: string | null };

export function showCreateRoomDialog(options: {
  spaceName: string;
  categories: { id: string; name: string }[];
  initialCategoryId?: string;
  create: (room: NewRoom) => Promise<void>;
  error: (error: unknown) => string;
}) {
  const dialog = document.createElement("dialog");
  dialog.className = "create-room-dialog";
  dialog.setAttribute("aria-label", "Create room");
  const form = document.createElement("form");
  const heading = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = "Create room";
  const subtitle = document.createElement("p");
  subtitle.textContent = options.spaceName;
  heading.append(title, subtitle);
  const types = document.createElement("fieldset");
  types.className = "create-room-types";
  const legend = document.createElement("legend");
  legend.textContent = "Room type";
  types.append(legend);
  for (const kind of ["text", "voice"] as const) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "room-kind";
    input.value = kind;
    input.checked = kind === "text";
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = kind === "text" ? "Text" : "Voice";
    const description = document.createElement("small");
    description.textContent = kind === "text" ? "Messages, files, and reactions" : "Encrypted audio conversations";
    copy.append(name, description);
    label.append(input, iconElement(kind === "text" ? "hash" : "headphones"), copy);
    types.append(label);
  }
  const nameLabel = document.createElement("label");
  nameLabel.className = "create-room-field";
  nameLabel.textContent = "Room name";
  const name = document.createElement("input");
  name.name = "room-name";
  name.setAttribute("aria-label", "Room name");
  name.required = true;
  name.maxLength = 80;
  name.placeholder = "e.g. general";
  name.autocomplete = "off";
  nameLabel.append(name);
  const categoryLabel = document.createElement("label");
  categoryLabel.className = "create-room-field";
  categoryLabel.textContent = "Category";
  const category = document.createElement("select");
  category.name = "room-category";
  category.setAttribute("aria-label", "Category");
  category.add(new Option("No category", ""));
  for (const group of options.categories) category.add(new Option(group.name, group.id));
  category.value = options.categories.some((group) => group.id === options.initialCategoryId) ? options.initialCategoryId! : "";
  categoryLabel.append(category);
  const note = document.createElement("p");
  note.className = "create-room-note";
  note.textContent = "Room names and content are end-to-end encrypted. Category permissions still apply.";
  const status = document.createElement("p");
  status.className = "create-room-status";
  status.setAttribute("role", "status");
  const footer = document.createElement("footer");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close());
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Create room";
  footer.append(cancel, submit);
  form.append(heading, types, nameLabel, categoryLabel, note, status, footer);
  dialog.append(form);
  const previouslyFocused = document.activeElement;
  let saving = false;
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const normalized = name.value.trim();
    if (!normalized) { name.setCustomValidity("Enter a room name."); name.reportValidity(); return; }
    const kind = form.querySelector<HTMLInputElement>('input[name="room-kind"]:checked')?.value === "voice" ? "voice" : "text";
    saving = true;
    submit.disabled = true;
    cancel.disabled = true;
    types.disabled = true;
    name.disabled = true;
    category.disabled = true;
    status.textContent = "Creating encrypted room…";
    try { await options.create({ name: normalized, kind, categoryId: category.value || null }); dialog.close(); }
    catch (error) {
      status.textContent = options.error(error);
      saving = false;
      submit.disabled = false;
      cancel.disabled = false;
      types.disabled = false;
      name.disabled = false;
      category.disabled = false;
    }
  });
  name.addEventListener("input", () => name.setCustomValidity(""));
  document.body.append(dialog);
  renderIcons(dialog);
  dialog.showModal();
  name.focus();
}
