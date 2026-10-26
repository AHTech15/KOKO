// Shared avatar drawing + photo shrinking
export const palette = ["#22c55e", "#3b82f6", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6"];
export const emojis = ["😀", "😎", "🤩", "🥳", "😺", "🐼", "🦊", "🐯", "🌟", "🔥", "🎧", "⚽"];

const cssLink = document.createElement("link");
cssLink.rel = "stylesheet";
cssLink.href = "avatar.css";
document.head.append(cssLink);

const PHOTO_OK = /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/;
const COLOR_OK = /^#[0-9a-fA-F]{6}$/;

export function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h + c.charCodeAt(0)) % palette.length;
  return palette[h];
}

/* o = { photo, emoji, color, group } (all optional) */
export function makeAvatar(name, o) {
  o = o || {};
  const d = document.createElement("div");
  d.className = "avatar";
  d.style.background = COLOR_OK.test(o.color || "") ? o.color : colorFor(name);
  if (o.group) {
    d.textContent = "👥";
    return d;
  }
  if (o.photo && o.photo.length <= 20000 && PHOTO_OK.test(o.photo)) {
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.alt = "";
    img.src = o.photo;
    d.append(img);
    return d;
  }
  d.textContent = o.emoji ? o.emoji : name.charAt(0).toUpperCase();
  return d;
}

/* Turn a chosen picture into a tiny square JPEG (as text) */
export async function photoFromFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("Please choose a picture.");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Could not read that picture."));
      i.src = url;
    });
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    for (const q of [0.8, 0.65, 0.5, 0.35]) {
      const data = canvas.toDataURL("image/jpeg", q);
      if (data.length <= 20000) return data;
    }
    throw new Error("That picture is too detailed. Try another one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
