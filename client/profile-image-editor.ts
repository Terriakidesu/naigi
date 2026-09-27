import { editProfileImage, isAnimatedGifFile, type CropRect } from "./profile-image-codec";

const OUTPUT_SIZES = [128, 256, 512];

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function loadImage(image: HTMLImageElement, url: string) {
  return new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("profile_image_decode_failed"));
    image.src = url;
  });
}

class ProfileImageEditor {
  private readonly file: File;
  private readonly dialog: HTMLDialogElement;
  private readonly stage: HTMLElement;
  private readonly image: HTMLImageElement;
  private readonly zoomInput: HTMLInputElement;
  private readonly sizeSelect: HTMLSelectElement;
  private readonly status: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly objectUrl: string;
  private resolveResult?: (file: File | null) => void;
  private closed = false;
  private loaded = false;
  private naturalWidth = 0;
  private naturalHeight = 0;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private dragging = false;
  private pointerId = -1;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private result: File | null = null;

  constructor(file: File) {
    this.file = file;
    this.objectUrl = URL.createObjectURL(file);
    this.dialog = document.createElement("dialog");
    this.dialog.className = "app-dialog profile-image-editor";
    this.stage = document.createElement("div");
    this.stage.className = "profile-crop-stage";
    this.image = document.createElement("img");
    this.zoomInput = document.createElement("input");
    this.sizeSelect = document.createElement("select");
    this.status = document.createElement("p");
    this.saveButton = document.createElement("button");
    this.cancelButton = document.createElement("button");
    this.build();
  }

  open() {
    const result = new Promise<File | null>((resolve) => {
      this.resolveResult = resolve;
    });
    document.body.append(this.dialog);
    this.dialog.showModal();
    void this.prepare();
    return result;
  }

  private build() {
    const heading = document.createElement("h2");
    heading.textContent = "Adjust profile image";
    const description = document.createElement("p");
    description.className = "muted profile-image-editor-description";
    description.textContent = isAnimatedGifFile(this.file)
      ? "Drag to crop, zoom, and resize. Animated GIF frames are preserved."
      : "Drag to crop, zoom, and resize before saving.";

    this.image.className = "profile-crop-image";
    this.image.alt = "Profile image preview";
    this.image.draggable = false;
    this.stage.append(this.image);

    const controls = document.createElement("div");
    controls.className = "profile-image-editor-controls";
    const sizeLabel = document.createElement("label");
    sizeLabel.textContent = "Resize output";
    for (const size of OUTPUT_SIZES) {
      const option = document.createElement("option");
      option.value = String(size);
      option.textContent = `${size} × ${size}`;
      if (size === 512) option.selected = true;
      this.sizeSelect.append(option);
    }
    sizeLabel.append(this.sizeSelect);
    const zoomLabel = document.createElement("label");
    zoomLabel.textContent = "Zoom";
    this.zoomInput.type = "range";
    this.zoomInput.min = "1";
    this.zoomInput.max = "3";
    this.zoomInput.step = "0.01";
    this.zoomInput.value = "1";
    this.zoomInput.setAttribute("aria-label", "Profile image zoom");
    zoomLabel.append(this.zoomInput);
    controls.append(sizeLabel, zoomLabel);

    this.status.className = "form-status profile-image-editor-status";
    this.status.textContent = "Drag the image to position the crop.";
    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    this.cancelButton.className = "secondary";
    this.cancelButton.type = "button";
    this.cancelButton.textContent = "Cancel";
    this.saveButton.type = "submit";
    this.saveButton.textContent = "Use this image";
    actions.append(this.cancelButton, this.saveButton);

    const form = document.createElement("form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.save();
    });
    form.append(heading, description, this.stage, controls, this.status, actions);
    this.dialog.append(form);

    this.zoomInput.addEventListener("input", () => {
      this.zoom = Number(this.zoomInput.value);
      this.renderPreview();
    });
    this.cancelButton.addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => this.finish());
    this.dialog.addEventListener("cancel", () => this.dialog.close());
    this.stage.addEventListener("pointerdown", (event) => {
      if (!this.loaded) return;
      this.dragging = true;
      this.pointerId = event.pointerId;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      this.stage.setPointerCapture(event.pointerId);
    });
    this.stage.addEventListener("pointermove", (event) => {
      if (!this.dragging || event.pointerId !== this.pointerId) return;
      this.panX += event.clientX - this.lastPointerX;
      this.panY += event.clientY - this.lastPointerY;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      this.renderPreview();
    });
    const stopDragging = (event: PointerEvent) => {
      if (event.pointerId === this.pointerId) this.dragging = false;
    };
    this.stage.addEventListener("pointerup", stopDragging);
    this.stage.addEventListener("pointercancel", stopDragging);
  }

  private async prepare() {
    try {
      await loadImage(this.image, this.objectUrl);
      this.naturalWidth = this.image.naturalWidth;
      this.naturalHeight = this.image.naturalHeight;
      if (!this.naturalWidth || !this.naturalHeight) throw new Error("profile_image_decode_failed");
      this.loaded = true;
      this.renderPreview();
    } catch {
      this.status.textContent = "This image could not be decoded by the browser.";
      this.status.classList.add("error");
      this.saveButton.disabled = true;
    }
  }

  private cropRect(): CropRect {
    const viewport = this.stage.clientWidth || 320;
    const scale = Math.max(viewport / this.naturalWidth, viewport / this.naturalHeight) * this.zoom;
    const imageWidth = this.naturalWidth * scale;
    const imageHeight = this.naturalHeight * scale;
    const centeredLeft = (viewport - imageWidth) / 2 + this.panX;
    const centeredTop = (viewport - imageHeight) / 2 + this.panY;
    const left = clamp(centeredLeft, viewport - imageWidth, 0);
    const top = clamp(centeredTop, viewport - imageHeight, 0);
    return { x: -left / scale, y: -top / scale, size: viewport / scale };
  }

  private renderPreview() {
    if (!this.loaded) return;
    const viewport = this.stage.clientWidth || 320;
    const scale = Math.max(viewport / this.naturalWidth, viewport / this.naturalHeight) * this.zoom;
    const width = this.naturalWidth * scale;
    const height = this.naturalHeight * scale;
    const left = clamp((viewport - width) / 2 + this.panX, viewport - width, 0);
    const top = clamp((viewport - height) / 2 + this.panY, viewport - height, 0);
    this.image.style.width = `${width}px`;
    this.image.style.height = `${height}px`;
    this.image.style.left = `${left}px`;
    this.image.style.top = `${top}px`;
  }

  private async save() {
    if (!this.loaded || this.saveButton.disabled) return;
    this.saveButton.disabled = true;
    this.cancelButton.disabled = true;
    this.status.classList.remove("error");
    this.status.textContent = isAnimatedGifFile(this.file) ? "Rendering animated GIF…" : "Rendering image…";
    try {
      const edited = await editProfileImage(this.file, this.image, this.cropRect(), Number(this.sizeSelect.value));
      this.result = edited;
      this.dialog.close();
    } catch (error) {
      this.cancelButton.disabled = false;
      this.saveButton.disabled = false;
      this.status.classList.add("error");
      this.status.textContent = error instanceof Error && error.message === "profile_image_too_large"
        ? "The edited image is over 5 MB. Choose a smaller output size."
        : error instanceof Error && error.message === "profile_image_animation_too_complex"
          ? "This GIF has too many frames to edit in the browser."
          : "This image could not be edited. Try another file.";
    }
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    URL.revokeObjectURL(this.objectUrl);
    this.resolveResult?.(this.result);
    this.dialog.remove();
  }
}

export function openProfileImageEditor(file: File) {
  return new ProfileImageEditor(file).open();
}
