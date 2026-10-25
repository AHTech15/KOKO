import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth } from "./firebase.js";
import { ensureProfile, onUserReady, onUserGone } from "./profile.js";

const $ = (id) => document.getElementById(id);
const authScreen = $("authScreen");
const appEl = $("app");
const form = $("authForm");
const errorEl = $("authError");
const submitBtn = $("authSubmit");
let mode = "login"; // "login" or "signup"
let creatingAccount = false;

function setMode(next) {
  mode = next;
  document.querySelectorAll(".auth-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.mode === next)
  );
  $("nameRow").hidden = next !== "signup";
  $("password").autocomplete = next === "signup" ? "new-password" : "current-password";
  submitBtn.textContent = next === "signup" ? "Create account" : "Log in";
  errorEl.textContent = "";
}

document.querySelectorAll(".auth-tab").forEach((tab) =>
  tab.addEventListener("click", () => setMode(tab.dataset.mode))
);

function friendlyError(code) {
  const messages = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/email-already-in-use": "An account with this email already exists. Try logging in.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/invalid-credential": "Wrong email or password.",
    "auth/user-not-found": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/too-many-requests": "Too many attempts. Please wait a bit and try again.",
    "auth/network-request-failed": "No internet connection. Please try again.",
    "auth/operation-not-allowed": "Email login is not enabled in Firebase yet.",
    "auth/unauthorized-domain": "This website is not in Firebase's authorized domains."
  };
  return messages[code] || "Something went wrong. Please try again.";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";
  const email = $("email").value.trim();
  const password = $("password").value;
  const name = $("displayName").value.trim();

  if (mode === "signup" && (name.length < 2 || name.length > 30)) {
    errorEl.textContent = "Please enter a name between 2 and 30 characters.";
    return;
  }

  submitBtn.disabled = true;
  try {
    if (mode === "signup") {
      creatingAccount = true;
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await ensureProfile(cred.user, name);
      await onUserReady(cred.user);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    form.reset();
  } catch (err) {
    errorEl.textContent = friendlyError(err.code);
  } finally {
    creatingAccount = false;
    submitBtn.disabled = false;
  }
});

$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  authScreen.hidden = !!user;
  appEl.hidden = !user;
  if (user) {
    if (!creatingAccount) onUserReady(user);
  } else {
    onUserGone();
  }
});

setMode("login");
