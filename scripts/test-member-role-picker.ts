import { chromium } from "playwright";

const bundle = await Bun.build({ entrypoints: ["client/member-role-picker.ts"], target: "browser" });
if (!bundle.success) throw new Error("Could not build role picker fixture");
const js = `${await bundle.outputs[0].text()}
window.savedRoleIds = null;
window.failSave = false;
document.querySelector('#row').append(memberRolePicker({
  memberName: 'Terri', roles: [{id: 'admin', name: 'Administrator', color: '#aabbcc'}, {id: 'member', name: 'Member', color: '#99aabb'}], selected: ['member'],
  save: async (ids) => { if (window.failSave) throw new Error('Permission denied'); window.savedRoleIds = ids; },
  error: (error) => error.message
}));
const nestedButton = document.createElement('button');
nestedButton.textContent = 'Nested actions';
document.querySelector('#row').append(nestedButton);
const nestedMenu = document.createElement('div');
nestedMenu.className = 'member-actions-popover';
nestedMenu.append(memberRolePicker({ memberName: 'Nested member', roles: [{id:'admin',name:'Administrator',color:'#aabbcc'}], selected: [], save: async () => {}, error: (error) => error.message }));
nestedButton.addEventListener('click', () => showAnchoredPopover(nestedMenu, nestedButton));`;
const iconsBundle = await Bun.build({ entrypoints: ["client/icons.ts"], target: "browser" });
if (!iconsBundle.success) throw new Error("Could not build icon fixture");
const iconsJs = await iconsBundle.outputs[0].text();
const actionsFixture = `import { iconElement, renderIcons } from '/icons-fixture.js';
const button = document.createElement('button');
button.className = 'icon-button';
button.setAttribute('aria-label', 'Member actions');
button.append(iconElement('more-horizontal'));
document.querySelector('#row').append(button);
renderIcons(document.querySelector('#row'));
const menu = document.createElement('div');
menu.className = 'member-actions-popover';
menu.setAttribute('popover', 'auto');
menu.textContent = 'Copy user ID';
document.body.append(menu);
button.addEventListener('click', () => menu.showPopover());`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture.js") return new Response(`${actionsFixture}\n${js}`, { headers: { "content-type": "text/javascript" } });
  if (path === "/icons-fixture.js") return new Response(iconsJs, { headers: { "content-type": "text/javascript" } });
  if (path === "/app.css") return new Response(Bun.file("public/app.css"), { headers: { "content-type": "text/css" } });
  return new Response('<link rel="stylesheet" href="/app.css"><div class="server-settings-content"><div id="row" class="settings-list-row"><div class="settings-row-copy">Terri</div></div></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}`);
  const trigger = page.getByRole("button", { name: "Edit roles for Terri" });
  await trigger.waitFor();
  const actionsButton = page.getByRole("button", { name: "Member actions", exact: true });
  if (await actionsButton.locator("svg").count() !== 1) throw new Error("Member actions icon is missing");
  await actionsButton.click();
  await page.getByText("Copy user ID", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const height = (await page.locator("#row").boundingBox())!.height;
  await trigger.click();
  if ((await page.locator("#row").boundingBox())!.height !== height) throw new Error("Role picker expanded the member row");
  await page.getByRole("checkbox", { name: "Administrator" }).check();
  await page.getByRole("searchbox").fill("Member");
  if (await page.getByRole("checkbox").count() !== 1) throw new Error("Search failed");
  await page.getByRole("button", { name: "Save roles" }).click();
  const ids = await page.evaluate(() => (window as any).savedRoleIds);
  if (ids.length !== 2 || !ids.includes("admin") || !ids.includes("member")) throw new Error("Search lost checked roles");
  await trigger.click();
  await page.getByRole("checkbox", { name: "Member", exact: true }).uncheck();
  await page.getByRole("button", { name: "Cancel" }).click();
  await trigger.click();
  if (!await page.getByRole("checkbox", { name: "Member", exact: true }).isChecked()) throw new Error("Cancel retained unsaved selection");
  await page.getByRole("checkbox", { name: "Administrator" }).check();
  await page.evaluate(() => { (window as any).failSave = true; });
  await page.getByRole("button", { name: "Save roles" }).click();
  await page.getByText("Permission denied", { exact: true }).waitFor();
  if (!await page.getByRole("button", { name: "Save roles" }).isEnabled()) throw new Error("Failed save cannot be retried");
  await page.setViewportSize({ width: 390, height: 700 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Picker overflows mobile viewport");
  await page.keyboard.press("Escape");
  if (await page.locator(".member-role-dialog:popover-open").count()) throw new Error("Popover did not close");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Nested actions", exact: true }).click();
  await page.getByRole("button", { name: "Edit roles for Nested member", exact: true }).click();
  if (await page.locator(".member-actions-popover:popover-open").count() !== 1) throw new Error("Opening Roles closed its parent actions menu");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  if (await page.locator(".member-actions-popover:popover-open").count() !== 1) throw new Error("Closing Roles closed its parent menu");
  console.log("Member role picker checks passed: compact row, filtering, saved selection, cancel, errors, Escape, and mobile fit.");
} finally { await browser.close(); server.stop(true); }
