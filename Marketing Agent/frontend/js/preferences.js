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

  const prefs = $("prefsForm"),
    el = (n) => prefs.elements[n].value;
  const P = {
    tone: "friendly",
    language: "English",
    platforms: ["Facebook"],
    postFrequency: "weekly",
    brandColor: "#1d6b52",
    targetAudience: "",
    ...(user.preferences || {}),
  };
  ["tone", "language", "postFrequency", "brandColor", "targetAudience"].forEach(
    (k) => {
      prefs.elements[k].value = P[k];
    },
  );
  prefs.querySelectorAll("input[name=platforms]").forEach((c) => {
    c.checked = P.platforms.includes(c.value);
  });

  const chosen = () =>
    [...prefs.querySelectorAll("input[name=platforms]:checked")].map(
      (c) => c.value,
    );
  const summary = () => {
    $("summary").textContent = prefsSummary({
      tone: el("tone"),
      language: el("language"),
      platforms: chosen(),
      postFrequency: el("postFrequency"),
    });
  };
  prefs.addEventListener("input", summary);
  summary();

  prefs.addEventListener("submit", async (e) => {
    e.preventDefault();
    const platforms = chosen();
    $("platErr").textContent = platforms.length
      ? ""
      : "Choose at least one platform.";
    if (!platforms.length) return;
    try {
      Auth._me = (
        await api("/account", {
          method: "PATCH",
          body: {
            preferences: {
              tone: el("tone"),
              language: el("language"),
              platforms,
              postFrequency: el("postFrequency"),
              brandColor: el("brandColor"),
              targetAudience: el("targetAudience").trim(),
            },
          },
        })
      ).user;
      toast("Preferences saved.");
    } catch (err) {
      toast(err.message);
    }
  });
})();
