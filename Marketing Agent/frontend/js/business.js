const MAX_DESC = 500;
const $ = (id) => document.getElementById(id);

(async () => {
  const user = await Auth.me();
  if (!user) {
    location.replace("login.html");
    return;
  }
  if (user.role !== "owner") {
    location.replace("dashboard.html");
    return;
  }

  const form = $("profileForm"),
    f = (n) => form.elements[n];
  let logoData = "";

  try {
    const { profile } = await api("/profile");
    if (profile) {
      f("name").value = profile.name;
      f("category").value = profile.category || "";
      f("city").value = profile.city || "";
      f("description").value = profile.description;
      logoData = profile.logo || "";
    }
  } catch (err) {
    toast(err.message);
  }

  function preview() {
    const b = { name: f("name").value || "Your business name", logo: logoData };
    $("logoBox").innerHTML = logoData
      ? `<img src="${logoData}" alt="Logo preview">`
      : "No logo yet";
    $("removeLogo").hidden = !logoData;
    $("count").textContent = `${f("description").value.length} / ${MAX_DESC}`;
    $("preview").style.borderTopColor =
      (user.preferences && user.preferences.brandColor) || "";
    $("preview").innerHTML = `
      <div class="card-head">${logoHTML(b)}<div><h3>${esc(b.name)}</h3>
      <div class="meta">${esc(f("category").value || "General")}${f("city").value ? " · " + esc(f("city").value) : ""}</div></div></div>
      <p>${esc(f("description").value || "Your description will appear here.")}</p>`;
  }

  /* Resize logo to 256x256 before sending it to the server */
  $("logo").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $("logoErr").textContent = "";
    if (!file.type.startsWith("image/")) {
      $("logoErr").textContent = "Choose an image file (PNG, JPG or WebP).";
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      $("logoErr").textContent =
        "Image is larger than 3 MB. Choose a smaller one.";
      return;
    }
    const img = new Image();
    img.onload = () => {
      const s = 256,
        c = document.createElement("canvas");
      c.width = c.height = s;
      const m = Math.min(img.width, img.height);
      c.getContext("2d").drawImage(
        img,
        (img.width - m) / 2,
        (img.height - m) / 2,
        m,
        m,
        0,
        0,
        s,
        s,
      );
      logoData = c.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(img.src);
      preview();
    };
    img.onerror = () => {
      $("logoErr").textContent = "This image could not be read.";
    };
    img.src = URL.createObjectURL(file);
  });
  $("removeLogo").addEventListener("click", () => {
    logoData = "";
    $("logo").value = "";
    preview();
  });
  form.addEventListener("input", preview);
  f("description").maxLength = MAX_DESC;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = f("name").value.trim(),
      desc = f("description").value.trim();
    $("nameErr").textContent = name ? "" : "Enter your business name.";
    $("descErr").textContent =
      desc.length >= 20
        ? ""
        : "Describe your business in at least 20 characters.";
    if (!name || desc.length < 20) return;
    try {
      await api("/profile", {
        method: "PUT",
        body: {
          name,
          category: f("category").value,
          city: f("city").value,
          description: desc,
          logo: logoData,
        },
      });
      toast("Business profile saved. It now appears in the marketplace.");
    } catch (err) {
      toast(err.message);
    }
  });
  preview();
})();
