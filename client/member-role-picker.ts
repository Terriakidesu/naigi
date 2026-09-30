import { showAnchoredPopover } from "./anchored-popover";

type RoleChoice = { id: string; name: string; color: string };

export function memberRolePicker(options: {
  memberName: string;
  roles: RoleChoice[];
  selected: string[];
  save: (ids: string[]) => Promise<void>;
  error: (error: unknown) => string;
}) {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "secondary member-role-edit-button";
  trigger.textContent = "Edit roles";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-label", `Edit roles for ${options.memberName}`);
  trigger.addEventListener("click", () => {
    const dialog = document.createElement("div");
    dialog.className = "member-role-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", `Roles for ${options.memberName}`);
    const heading = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "Assign roles";
    const name = document.createElement("span");
    name.textContent = options.memberName;
    heading.append(title, name);
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Find a role";
    search.setAttribute("aria-label", "Find a role to assign");
    const list = document.createElement("div");
    list.className = "member-role-choices";
    const selected = new Set(options.selected.filter((id) => options.roles.some((role) => role.id === id)));
    const initial = new Set(selected);
    const footer = document.createElement("footer");
    const status = document.createElement("p");
    status.className = "member-role-picker-status";
    status.setAttribute("role", "status");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save roles";
    save.disabled = true;
    let saving = false;
    const update = () => {
      save.disabled = saving || (selected.size === initial.size && [...selected].every((id) => initial.has(id)));
      status.textContent = `${selected.size} selected · All members applies automatically`;
    };
    const render = () => {
      list.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      for (const role of options.roles.filter((role) => role.name.toLocaleLowerCase().includes(query))) {
        const label = document.createElement("label");
        label.className = "member-role-choice";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(role.id);
        checkbox.disabled = saving;
        const swatch = document.createElement("span");
        swatch.className = "member-role-choice-swatch";
        swatch.style.backgroundColor = role.color;
        const text = document.createElement("span");
        text.textContent = role.name;
        label.append(checkbox, swatch, text);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(role.id); else selected.delete(role.id);
          update();
        });
        list.append(label);
      }
      if (!list.childElementCount) {
        const empty = document.createElement("p");
        empty.className = "muted small";
        empty.textContent = options.roles.length ? "No matching roles." : "No assignable roles yet.";
        list.append(empty);
      }
    };
    search.addEventListener("input", render);
    cancel.addEventListener("click", () => dialog.hidePopover());
    save.addEventListener("click", async () => {
      saving = true;
      save.disabled = true;
      cancel.disabled = true;
      search.disabled = true;
      render();
      status.textContent = "Saving…";
      try { await options.save([...selected]); if (dialog.matches(":popover-open")) dialog.hidePopover(); }
      catch (error) {
        saving = false;
        cancel.disabled = false;
        search.disabled = false;
        render();
        update();
        status.textContent = options.error(error);
      }
    });
    footer.append(cancel, save);
    dialog.append(heading, search, list, status, footer);
    render();
    update();
    showAnchoredPopover(dialog, trigger, undefined, true);
    search.focus();
  });
  return trigger;
}
