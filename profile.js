import { auth, db } from "./firebase.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, query, orderBy, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { makeAvatar, photoFromFile, palette, emojis } from "./avatar.js";

const $ = (id) => document.getElementById(id);

let me = null;            // { uid, displayName, bio, photo, emoji, color }
let people = [];          // other users
let peopleLoaded = false;
let selected = null;      // person whose card is open
let draft = { photo: "", emoji: "", color: "" };
let editor = null;

const optsOf = (p) => ({ photo: p.photo || "", emoji: p.avatarEmoji || "", color: p.avatarColor || "" });

function cleanName(raw) {
  let n = (raw || "").trim().slice(0, 30);
  if (n.length < 2) n = "KoKo user";
  return n;
}

/* Create the profile document if this account doesn't have one yet */
export async function ensureProfile(user, nameHint) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data();
  const name = cleanName(nameHint || user.displayName || (user.email || "").split("@")[0]);
  await setDoc(ref, {
    displayName: name,
    displayNameLower: name.toLowerCase(),
    bio: "",
    photo: "",
    avatarEmoji: "",
    avatarColor: "",
    createdAt: serverTimestamp()
  });
  return { displayName: name, bio: "", photo: "", avatarEmoji: "", avatarColor: "" };
}

export async function onUserReady(user) {
  try {
    const p = await ensureProfile(user);
    me = {
      uid: user.uid,
      displayName: p.displayName,
      bio: p.bio || "",
      photo: p.photo || "",
      emoji: p.avatarEmoji || "",
      color: p.avatarColor || ""
    };
    showMe();
  } catch (err) {
    console.error(err);
    $("userLine").textContent = "Could not load your profile. Check your Firestore rules.";
  }
}

export function onUserGone() {
  me = null;
  people = [];
  peopleLoaded = false;
  $("peopleList").innerHTML = "";
}

function showMe() {
  $("userLine").textContent = "Signed in as " + me.displayName + (me.bio ? " · " + me.bio : "");
  const btn = $("meBtn");
  btn.innerHTML = "";
  btn.append(makeAvatar(me.displayName, me));
}

/* ---------- Picture editor (inside the profile pop-up) ---------- */
function drawEditor() {
  if (!editor) return;
  const name = $("pName").value.trim() || (me ? me.displayName : "?");
  editor.preview.innerHTML = "";
  editor.preview.append(makeAvatar(name, draft));
  editor.removeBtn.hidden = !draft.photo;
  editor.emojiBtns.forEach((b) =>
    b.classList.toggle("on", !draft.photo && b.dataset.emoji === draft.emoji)
  );
  editor.swatchBtns.forEach((b) =>
    b.classList.toggle("on", b.dataset.color === draft.color)
  );
}

function buildEditor() {
  if (editor) return;
  const wrap = document.createElement("div");
  wrap.className = "avatar-editor";

  const preview = document.createElement("div");

  const actions = document.createElement("div");
  actions.className = "avatar-actions";
  const chooseBtn = document.createElement("button");
  chooseBtn.type = "button";
  chooseBtn.className = "av-btn";
  chooseBtn.textContent = "Choose photo";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "av-btn";
  removeBtn.textContent = "Remove photo";
  actions.append(chooseBtn, removeBtn);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.hidden = true;

  const hint = document.createElement("small");
  hint.className = "av-hint";
  hint.textContent = "Or pick an emoji and a color";

  const grid = document.createElement("div");
  grid.className = "emoji-grid";
  const emojiBtns = [];
  ["", ...emojis].forEach((e) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emoji-btn";
    b.dataset.emoji = e;
    b.textContent = e === "" ? "Aa" : e;
    b.style.fontSize = e === "" ? "0.9rem" : "";
    b.addEventListener("click", () => {
      draft.emoji = e;
      draft.photo = "";
      drawEditor();
    });
    grid.append(b);
    emojiBtns.push(b);
  });

  const swatches = document.createElement("div");
  swatches.className = "swatches";
  const swatchBtns = [];
  palette.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute("aria-label", "Color " + c);
    b.addEventListener("click", () => {
      draft.color = draft.color === c ? "" : c;
      drawEditor();
    });
    swatches.append(b);
    swatchBtns.push(b);
  });

  chooseBtn.addEventListener("click", () => fileInput.click());
  removeBtn.addEventListener("click", () => {
    draft.photo = "";
    drawEditor();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    $("profileMsg").textContent = "";
    if (file) {
      try {
        draft.photo = await photoFromFile(file);
      } catch (err) {
        $("profileMsg").textContent = err.message || "Could not use that picture.";
      }
    }
    fileInput.value = "";
    drawEditor();
  });
  $("pName").addEventListener("input", drawEditor);

  wrap.append(preview, actions, hint, grid, swatches, fileInput);
  $("profileForm").prepend(wrap);
  editor = { preview, removeBtn, emojiBtns, swatchBtns };
}

/* ---------- My profile screen ---------- */
$("meBtn").addEventListener("click", () => {
  if (!me) return;
  buildEditor();
  draft = { photo: me.photo, emoji: me.emoji, color: me.color };
  $("pName").value = me.displayName;
  $("pBio").value = me.bio;
  $("bioCount").textContent = me.bio.length + "/140";
  $("profileMsg").textContent = "";
  drawEditor();
  $("profileModal").hidden = false;
});
$("pBio").addEventListener("input", () => {
  $("bioCount").textContent = $("pBio").value.length + "/140";
});
$("profileClose").addEventListener("click", () => ($("profileModal").hidden = true));

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("pName").value.trim();
  const bio = $("pBio").value.trim();
  const msg = $("profileMsg");
  if (name.length < 2 || name.length > 30) {
    msg.textContent = "Name must be 2 to 30 characters.";
    return;
  }
  if (bio.length > 140) {
    msg.textContent = "About you must be 140 characters or less.";
    return;
  }
  try {
    await updateDoc(doc(db, "users", me.uid), {
      displayName: name,
      displayNameLower: name.toLowerCase(),
      bio,
      photo: draft.photo,
      avatarEmoji: draft.emoji,
      avatarColor: draft.color
    });
    await updateProfile(auth.currentUser, { displayName: name });
    me.displayName = name;
    me.bio = bio;
    me.photo = draft.photo;
    me.emoji = draft.emoji;
    me.color = draft.color;
    showMe();
    peopleLoaded = false;
    $("profileModal").hidden = true;
  } catch (err) {
    console.error(err);
    msg.textContent = "Could not save. Please try again.";
  }
});

/* ---------- People tab ---------- */
async function loadPeople() {
  const list = $("peopleList");
  list.innerHTML = "";
  const note = document.createElement("li");
  note.className = "empty-note";
  note.textContent = "Loading...";
  list.append(note);
  try {
    const q = query(collection(db, "users"), orderBy("displayNameLower"), limit(50));
    const snap = await getDocs(q);
    people = [];
    snap.forEach((d) => {
      if (me && d.id === me.uid) return;
      people.push({ uid: d.id, ...d.data() });
    });
    peopleLoaded = true;
    renderPeople();
  } catch (err) {
    console.error(err);
    note.textContent = "Could not load people. Please try again.";
  }
}

function renderPeople() {
  const list = $("peopleList");
  list.innerHTML = "";
  const term = $("search").value.trim().toLowerCase();
  const shown = people.filter((p) => p.displayNameLower.includes(term));
  if (shown.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = people.length === 0
      ? "No one else has joined yet. Invite a friend!"
      : "No matching people.";
    list.append(li);
    return;
  }
  shown.forEach((p) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "chat-item";
    const info = document.createElement("div");
    info.className = "chat-info";
    const name = document.createElement("strong");
    name.textContent = p.displayName;
    const prev = document.createElement("div");
    prev.className = "preview";
    prev.textContent = p.bio || "Hey there! I'm using KoKo.";
    info.append(name, prev);
    btn.append(makeAvatar(p.displayName, optsOf(p)), info);
    btn.addEventListener("click", () => openPerson(p));
    li.append(btn);
    list.append(li);
  });
}

function openPerson(p) {
  selected = p;
  const holder = $("personAvatar");
  holder.innerHTML = "";
  holder.append(makeAvatar(p.displayName, optsOf(p)));
  $("personName").textContent = p.displayName;
  $("personBio").textContent = p.bio || "Hey there! I'm using KoKo.";
  $("personModal").hidden = false;
}
$("personClose").addEventListener("click", () => ($("personModal").hidden = true));

$("personMsg").addEventListener("click", () => {
  if (!selected) return;
  document.dispatchEvent(new CustomEvent("koko:message", { detail: { uid: selected.uid } }));
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const isPeople = tab.dataset.filter === "people";
    $("peopleList").hidden = !isPeople;
    $("chatList").hidden = isPeople;
    if (isPeople && !peopleLoaded) loadPeople();
    else if (isPeople) renderPeople();
  });
});

$("search").addEventListener("input", () => {
  if (!$("peopleList").hidden && peopleLoaded) renderPeople();
});
