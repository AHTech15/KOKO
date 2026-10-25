import { auth, db } from "./firebase.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, query, orderBy, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const palette = ["#22c55e", "#3b82f6", "#14b8a6", "#f59e0b", "#ec4899", "#8b5cf6"];

let me = null;            // { uid, displayName, bio }
let people = [];          // other users
let peopleLoaded = false;
let selected = null;      // person whose card is open

function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h + c.charCodeAt(0)) % palette.length;
  return palette[h];
}

function makeAvatar(name) {
  const d = document.createElement("div");
  d.className = "avatar";
  d.style.background = colorFor(name);
  d.textContent = name.charAt(0).toUpperCase();
  return d;
}

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
    createdAt: serverTimestamp()
  });
  return { displayName: name, bio: "" };
}

export async function onUserReady(user) {
  try {
    const p = await ensureProfile(user);
    me = { uid: user.uid, displayName: p.displayName, bio: p.bio || "" };
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
  $("meBtn").textContent = me.displayName.charAt(0).toUpperCase();
}

/* ---------- My profile screen ---------- */
$("meBtn").addEventListener("click", () => {
  if (!me) return;
  $("pName").value = me.displayName;
  $("pBio").value = me.bio;
  $("bioCount").textContent = me.bio.length + "/140";
  $("profileMsg").textContent = "";
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
      bio
    });
    await updateProfile(auth.currentUser, { displayName: name });
    me.displayName = name;
    me.bio = bio;
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
    btn.append(makeAvatar(p.displayName), info);
    btn.addEventListener("click", () => openPerson(p));
    li.append(btn);
    list.append(li);
  });
}

function openPerson(p) {
  selected = p;
  const holder = $("personAvatar");
  holder.innerHTML = "";
  holder.append(makeAvatar(p.displayName));
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
