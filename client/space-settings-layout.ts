/** Local filtering only: decrypted names never leave the browser. */
export function setupSpaceSettingsLists() {
  const lists = [
    ["category-settings-list", "Filter groups"], ["channel-settings-list", "Filter rooms"],
    ["member-settings-list", "Find a member"], ["moderation-settings-list", "Filter actions"],
    ["emoji-settings-list", "Find emoji"], ["audit-log-list", "Filter activity"],
  ];
  for (const [id, placeholder] of lists) {
    const list = document.getElementById(id);
    if (!list) continue;
    const toolbar = document.createElement("div");
    toolbar.className = "space-list-toolbar";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = placeholder!;
    search.setAttribute("aria-label", placeholder!);
    const count = document.createElement("span");
    count.className = "space-list-count";
    const empty = document.createElement("p");
    empty.className = "space-list-empty";
    empty.textContent = "No matching results.";
    empty.hidden = true;
    toolbar.append(search, count);
    list.before(toolbar);
    list.after(empty);
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase();
      const rows = [...list.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("settings-list-row"));
      let visible = 0;
      for (const row of rows) {
        const names = [...row.querySelectorAll<HTMLInputElement>("input:not([type='number'])")].map((input) => input.value).join(" ");
        row.hidden = !`${row.textContent} ${names}`.toLocaleLowerCase().includes(query);
        if (!row.hidden) visible += 1;
      }
      count.textContent = query ? `${visible} of ${rows.length}` : `${rows.length} total`;
      empty.hidden = !query || visible > 0;
    };
    search.addEventListener("input", filter);
    list.addEventListener("input", filter);
    new MutationObserver(filter).observe(list, { childList: true, subtree: true, characterData: true });
    filter();
  }
}
