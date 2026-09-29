const databaseName = "naigi-theme-assets";
const storeName = "backgrounds";

type ThemeAssetRecord = { id: string; image: Blob; updatedAt: number };

function openThemeAssetStore() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("Theme image storage is unavailable in this browser."));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "id" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Theme image storage is unavailable.")));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Unable to store the theme image.")));
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Unable to store the theme image.")));
  });
}

export async function saveThemeBackgroundImage(id: string, image: Blob) {
  const database = await openThemeAssetStore();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put({ id, image, updatedAt: Date.now() } satisfies ThemeAssetRecord);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function readThemeBackgroundImage(id: string) {
  const database = await openThemeAssetStore();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(id) as IDBRequest<ThemeAssetRecord | undefined>;
    const record = await new Promise<ThemeAssetRecord | undefined>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("Unable to load the theme image.")));
    });
    return record?.image;
  } finally {
    database.close();
  }
}

export async function deleteThemeBackgroundImages(ids: readonly string[]) {
  if (ids.length === 0 || !globalThis.indexedDB) return;
  const database = await openThemeAssetStore();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    for (const id of ids) store.delete(id);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

const themeImageUrls = new WeakMap<HTMLElement, { id: string; url: string; request: number }>();
const themeImageRequests = new WeakMap<HTMLElement, number>();
let imageRequestSequence = 0;

export function applyThemeBackgroundImage(target: HTMLElement, assetId: string | undefined, enabled: boolean) {
  const current = themeImageUrls.get(target);
  if (!enabled || !assetId) {
    themeImageRequests.set(target, ++imageRequestSequence);
    target.style.setProperty("--theme-background-image", "none");
    if (current) URL.revokeObjectURL(current.url);
    themeImageUrls.delete(target);
    return;
  }
  if (current?.id === assetId) {
    target.style.setProperty("--theme-background-image", `url("${current.url}")`);
    return;
  }
  const request = ++imageRequestSequence;
  themeImageRequests.set(target, request);
  void readThemeBackgroundImage(assetId).then((image) => {
    if (themeImageRequests.get(target) !== request) return;
    if (!image) {
      target.style.setProperty("--theme-background-image", "none");
      return;
    }
    const url = URL.createObjectURL(image);
    const previous = themeImageUrls.get(target);
    if (previous) URL.revokeObjectURL(previous.url);
    themeImageUrls.set(target, { id: assetId, url, request });
    target.style.setProperty("--theme-background-image", `url("${url}")`);
  }).catch(() => {
    if (themeImageRequests.get(target) === request) target.style.setProperty("--theme-background-image", "none");
  });
}
