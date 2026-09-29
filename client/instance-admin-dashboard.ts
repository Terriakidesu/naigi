import { ApiClient, type AdminIdentity } from "./api";

export async function initializeAdminDashboard(api: ApiClient): Promise<AdminIdentity> {
  const { operator } = await api.adminMe();

  const name = document.getElementById("admin-operator-name");
  const role = document.getElementById("admin-operator-role");
  if (name) name.textContent = operator.username;
  if (role) role.textContent = operator.role === "admin" ? "Administrator · host operator" : "Moderator · host operator";

  for (const element of document.querySelectorAll<HTMLElement>("[data-admin-only]")) {
    element.hidden = operator.role !== "admin";
  }

  if (document.body.dataset.adminRoleRequired === "admin" && operator.role !== "admin") {
    window.location.replace("/instance-admin");
  }
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void api.adminMe().then(({ operator: active }) => {
      if (active.id !== operator.id || active.role !== operator.role) window.location.reload();
    }).catch(() => window.location.assign("/instance-admin"));
  }, 60_000);
  return operator;
}
