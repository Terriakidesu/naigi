const storageKey = "priv-chat.instance-admin-theme";
type AdminThemeChoice = "system" | "light" | "dark";

function isThemeChoice(value: string | undefined): value is AdminThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

export function initializeAdminTheme() {
  const select = document.getElementById("instance-admin-theme") as HTMLSelectElement | null;
  const root = document.documentElement;
  const systemPreference = window.matchMedia("(prefers-color-scheme: dark)");
  let choice: AdminThemeChoice;
  const bootChoice = root.dataset.adminThemeChoice;
  if (isThemeChoice(bootChoice)) {
    choice = bootChoice;
  } else {
    try {
      const storedChoice = localStorage.getItem(storageKey) ?? undefined;
      choice = isThemeChoice(storedChoice) ? storedChoice : "system";
    } catch {
      choice = "system";
    }
  }

  function setChoice(nextChoice: AdminThemeChoice) {
    choice = nextChoice;
    root.dataset.adminThemeChoice = choice;
    root.dataset.adminTheme = choice === "system" ? (systemPreference.matches ? "dark" : "light") : choice;
    if (select) select.value = choice;
    try {
      localStorage.setItem(storageKey, choice);
    } catch {
      // Theme selection still applies for this page when storage is unavailable.
    }
  }

  setChoice(choice);
  select?.addEventListener("change", () => {
    if (isThemeChoice(select.value)) setChoice(select.value);
  });
  systemPreference.addEventListener("change", (event) => {
    if (choice === "system") root.dataset.adminTheme = event.matches ? "dark" : "light";
  });
}
