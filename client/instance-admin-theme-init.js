(() => {
  const key = "priv-chat.instance-admin-theme";
  const root = document.documentElement;
  const preference = window.matchMedia("(prefers-color-scheme: dark)");
  let choice = "system";
  try {
    const stored = localStorage.getItem(key);
    if (stored === "light" || stored === "dark") choice = stored;
  } catch {}
  root.dataset.adminThemeChoice = choice;
  root.dataset.adminTheme = choice === "system" ? (preference.matches ? "dark" : "light") : choice;
})();
