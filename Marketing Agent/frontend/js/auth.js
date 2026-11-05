/* Login + signup form handling (works on both pages) */
const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
Auth.me().then((u) => {
  if (u) location.replace("dashboard.html");
});

function setErr(form, name, msg) {
  const el = form.querySelector(`[data-err="${name}"]`);
  if (el) el.textContent = msg || "";
  return !msg;
}

const loginForm = document.getElementById("loginForm");
const signupForm = document.getElementById("signupForm");

async function submit(form, validate, action) {
  const msg = form.querySelector(".form-msg");
  msg.textContent = "";
  if (!validate()) return;
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await action();
    location.href = "dashboard.html";
  } catch (err) {
    msg.textContent = err.message;
    btn.disabled = false;
  }
}

loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = loginForm,
    email = f.elements["email"].value,
    pw = f.elements["password"].value;
  submit(
    f,
    () =>
      [
        setErr(
          f,
          "email",
          emailOk(email) ? "" : "Enter a valid email address.",
        ),
        setErr(f, "password", pw ? "" : "Enter your password."),
      ].every(Boolean),
    () => Auth.login(email, pw),
  );
});

signupForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = signupForm,
    v = {
      name: f.elements["name"].value,
      email: f.elements["email"].value,
      password: f.elements["password"].value,
      role: f.elements["role"].value,
    };
  submit(
    f,
    () =>
      [
        setErr(
          f,
          "name",
          v.name.trim().length >= 2 ? "" : "Enter your full name.",
        ),
        setErr(
          f,
          "email",
          emailOk(v.email) ? "" : "Enter a valid email address.",
        ),
        setErr(
          f,
          "password",
          v.password.length >= 8 ? "" : "Use at least 8 characters.",
        ),
        setErr(
          f,
          "confirm",
          f.elements["confirm"].value === v.password
            ? ""
            : "Passwords do not match.",
        ),
      ].every(Boolean),
    () => Auth.signup(v),
  );
});
