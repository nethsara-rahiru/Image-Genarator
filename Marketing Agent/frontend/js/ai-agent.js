const agentElement = (id) => document.getElementById(id);
const agentImage = (value) =>
  typeof value === "string" &&
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value
    : "";
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
  let profile,
    products = [],
    offset = 0,
    total = 0,
    imageData = "",
    imageVersion = 0,
    imageLoading = false,
    loadSequence = 0;
  const status = (message) => {
    agentElement("agentStatus").textContent = message;
  };
  let submitting = false,
    promotionOffset = 0,
    pollTimer,
    promotionLoading = false;
  const pendingStates = new Set([
    "queued",
    "prompting",
    "submitting",
    "generating",
    "downloading",
  ]);
  const promotionCards = new Map(),
    submissionKeys = new Map();
  async function openPromotion(type, product) {
    if (submitting) return;
    if (!profile) {
      status("Set up your business profile before promoting.");
      return;
    }
    submitting = true;
    document
      .querySelectorAll(".agent-promote")
      .forEach((button) => (button.disabled = true));
    status("Starting promotion…");
    try {
      const targetKey = product?._id || "business";
      if (!submissionKeys.has(targetKey))
        submissionKeys.set(
          targetKey,
          Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
            n.toString(16).padStart(2, "0"),
          ).join(""),
        );
      const result = await api("/promotions", {
        method: "POST",
        headers: { "Idempotency-Key": submissionKeys.get(targetKey) },
        body: {
          targetType: type,
          ...(product ? { productId: product._id } : {}),
        },
      });
      submissionKeys.delete(targetKey);
      status(
        `Promotion started for ${result.promotion.targetName}. Preparing up to four images.`,
      );
      promotionOffset = 0;
      await loadPromotions();
      agentElement("promotionResults").scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    } catch (error) {
      status(error.message);
    } finally {
      submitting = false;
      document
        .querySelectorAll(".agent-promote")
        .forEach((button) => (button.disabled = !profile));
    }
  }
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function renderPromotion(run) {
    let entry = promotionCards.get(run.id);
    if (!entry) {
      const article = make("article", "", "card promotion-run");
      article.dataset.promotionId = run.id;
      const title = make("h3"),
        progress = make("p"),
        error = make("p", "", "err");
      const cancel = make("button", "Cancel remaining images", "btn btn-ghost");
      cancel.type = "button";
      cancel.onclick = async () => {
        if (
          !confirm(
            "Stop remaining images? A remote job already submitted may still finish. Saved images are kept.",
          )
        )
          return;
        cancel.disabled = true;
        try {
          await api(`/promotions/${run.id}/cancel`, { method: "POST" });
          await loadPromotions();
        } catch (err) {
          error.textContent = err.message;
        } finally {
          cancel.disabled = false;
        }
      };
      const grid = make("div", "", "agent-grid");
      const slots = Array.from({ length: 4 }, (_, i) => {
        const item = make("section", "", "promotion-image");
        const heading = make("h4", `Image ${i + 1}`),
          state = make("p", "Waiting", "hint");
        const image = make("img");
        image.alt = `${run.targetName} promotion ${i + 1}`;
        image.hidden = true;
        image.loading = "lazy";
        const download = make("a", "Download original", "btn btn-ghost");
        download.hidden = true;
        const details = make("details"),
          summary = make("summary", "Generation prompt"),
          prompt = make("p");
        details.append(summary, prompt);
        details.hidden = true;
        item.append(heading, state, image, download, details);
        grid.append(item);
        return { state, image, download, details, prompt };
      });
      article.append(title, progress, error, cancel, grid);
      entry = { article, title, progress, error, cancel, slots };
      promotionCards.set(run.id, entry);
    }
    entry.title.textContent = run.targetName;
    entry.progress.textContent = `${run.completed} / 4 images saved · ${run.state.replaceAll("_", " ")}${pendingStates.has(run.state) ? ` · working on image ${run.current}` : ""}`;
    entry.error.textContent = run.error
      ? `${run.error.code}: ${run.error.message}`
      : "";
    entry.cancel.hidden = !pendingStates.has(run.state);
    for (const [i, item] of run.items.entries()) {
      const slot = entry.slots[i];
      slot.state.textContent = item.completedAt
        ? `Saved · ${item.width} × ${item.height} · ${item.bytes < 1024 ? item.bytes + " B" : Math.round(item.bytes / 1024) + " KB"}`
        : item.remoteState ||
          (i + 1 === run.current ? run.state.replaceAll("_", " ") : "Waiting");
      slot.prompt.textContent = item.prompt || "";
      slot.details.hidden = !item.prompt;
      slot.image.hidden = slot.download.hidden = !item.imageUrl;
      if (item.imageUrl && slot.image.getAttribute("src") !== item.imageUrl) {
        slot.image.src = item.imageUrl;
        slot.download.href = item.imageUrl + "?download=1";
      }
    }
    return entry.article;
  }
  async function loadPromotions() {
    if (promotionLoading) return;
    promotionLoading = true;
    clearTimeout(pollTimer);
    try {
      const result = await api(`/promotions?limit=5&offset=${promotionOffset}`);
      const area = agentElement("promotionRuns");
      const cards = result.promotions.map(renderPromotion);
      area.replaceChildren(
        ...(cards.length
          ? cards
          : [
              make(
                "p",
                "No promotions yet. Click Promote on your business or a product to generate four images.",
              ),
            ]),
      );
      const currentIds = new Set(result.promotions.map((run) => run.id));
      for (const id of promotionCards.keys())
        if (!currentIds.has(id)) promotionCards.delete(id);
      agentElement("promotionPage").textContent = result.total
        ? `${promotionOffset + 1}–${promotionOffset + cards.length} of ${result.total}`
        : "0 promotions";
      agentElement("previousPromotions").disabled = promotionOffset === 0;
      agentElement("nextPromotions").disabled =
        promotionOffset + cards.length >= result.total;
      agentElement("promotionStatus").textContent =
        "Updates every 3 seconds while a promotion is active. Google sign-in, if required, is manual on the image-generator computer.";
      if (result.promotions.some((run) => pendingStates.has(run.state)))
        pollTimer = setTimeout(loadPromotions, 3000);
    } catch (error) {
      agentElement("promotionStatus").textContent =
        error.message + " Retrying…";
      pollTimer = setTimeout(loadPromotions, 5000);
    } finally {
      promotionLoading = false;
    }
  }
  agentElement("refreshPromotions").onclick = loadPromotions;
  agentElement("previousPromotions").onclick = () => {
    if (!promotionLoading) {
      promotionOffset = Math.max(0, promotionOffset - 5);
      loadPromotions();
    }
  };
  agentElement("nextPromotions").onclick = () => {
    if (!promotionLoading) {
      promotionOffset += 5;
      loadPromotions();
    }
  };
  function card(name, image, onPromote) {
    const article = document.createElement("article");
    article.className = "card agent-card";
    const media = document.createElement("div");
    media.className = "agent-media";
    if (agentImage(image)) {
      const img = document.createElement("img");
      img.src = image;
      img.alt = name;
      media.append(img);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "agent-initials";
      placeholder.textContent = name.slice(0, 2).toUpperCase();
      media.append(placeholder);
    }
    const promote = document.createElement("button");
    promote.type = "button";
    promote.className = "btn btn-primary agent-promote";
    promote.textContent = "Promote";
    promote.setAttribute("aria-label", `Promote ${name}`);
    promote.disabled = !profile;
    promote.onclick = onPromote;
    const title = document.createElement("h3");
    title.textContent = name;
    media.append(promote);
    article.append(media, title);
    return article;
  }
  async function load() {
    const sequence = ++loadSequence;
    status("Loading your business and products…");
    agentElement("reloadAgent").disabled = true;
    try {
      const [business, catalog] = await Promise.all([
        api("/profile"),
        api(`/products?limit=20&offset=${offset}`),
      ]);
      if (sequence !== loadSequence) return;
      profile = business.profile;
      products = catalog.products;
      total = catalog.total;
      const businessBox = agentElement("agentBusiness");
      businessBox.replaceChildren();
      if (profile) {
        const brand = card(profile.name, profile.logo, () =>
          openPromotion("business"),
        );
        const detail = document.createElement("p");
        detail.textContent = profile.description;
        brand.append(detail);
        businessBox.append(brand);
      } else {
        const link = document.createElement("a");
        link.href = "business.html";
        link.textContent = "Set up your business name and logo";
        businessBox.append(link);
      }
      const grid = agentElement("agentProducts");
      grid.replaceChildren();
      for (const product of products) {
        const item = card(product.name, product.image, () =>
          openPromotion("product", product),
        );
        const description = document.createElement("p");
        description.textContent = product.description;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn btn-ghost";
        remove.textContent = "Remove product";
        remove.setAttribute("aria-label", `Remove ${product.name}`);
        remove.onclick = async () => {
          if (
            !confirm(
              `Remove ${product.name} from your catalog? Saved drafts are kept.`,
            )
          )
            return;
          remove.disabled = true;
          try {
            await api(`/products/${product._id}`, { method: "DELETE" });
            if (products.length === 1 && offset)
              offset = Math.max(0, offset - 20);
            await load();
          } catch (error) {
            status(error.message);
            remove.disabled = false;
          }
        };
        item.append(description, remove);
        grid.append(item);
      }
      if (!products.length) {
        const empty = document.createElement("p");
        empty.textContent =
          "No listed products yet. Add a product below to prepare its promotion.";
        grid.append(empty);
      }
      agentElement("productPage").textContent = total
        ? `${offset + 1}–${offset + products.length} of ${total}`
        : "0 products";
      agentElement("previousProducts").disabled = offset === 0;
      agentElement("nextProducts").disabled = offset + products.length >= total;
      status(
        profile
          ? `${profile.name} · ${total} listed product${total === 1 ? "" : "s"}`
          : "Business setup required before promotion.",
      );
    } catch (error) {
      if (sequence === loadSequence)
        status(error.message + " Use Refresh to try again.");
    } finally {
      if (sequence === loadSequence)
        agentElement("reloadAgent").disabled = false;
    }
  }
  agentElement("reloadAgent").onclick = load;
  agentElement("previousProducts").onclick = () => {
    offset = Math.max(0, offset - 20);
    load();
  };
  agentElement("nextProducts").onclick = () => {
    offset += 20;
    load();
  };
  agentElement("productImage").onchange = (event) => {
    const file = event.target.files[0],
      version = ++imageVersion;
    imageData = "";
    imageLoading = false;
    agentElement("productPreview").hidden = true;
    agentElement("productError").textContent = "";
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 3 * 1024 * 1024
    ) {
      agentElement("productError").textContent =
        "Choose a PNG, JPEG or WebP image up to 3 MB.";
      return;
    }
    imageLoading = true;
    const image = new Image(),
      url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        if (version !== imageVersion) return;
        const scale = Math.min(1, 768 / image.width, 768 / image.height),
          canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.8, 0.6, 0.4]) {
          imageData = canvas.toDataURL("image/jpeg", quality);
          if (imageData.length <= 400000) break;
        }
        if (imageData.length > 400000) {
          imageData = "";
          throw new Error("Choose a smaller image.");
        }
        agentElement("productPreview").src = imageData;
        agentElement("productPreview").hidden = false;
      } catch (error) {
        agentElement("productError").textContent = error.message;
      } finally {
        URL.revokeObjectURL(url);
        if (version === imageVersion) imageLoading = false;
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      if (version === imageVersion) {
        imageLoading = false;
        agentElement("productError").textContent =
          "This image could not be read.";
      }
    };
    image.src = url;
  };
  agentElement("productForm").onsubmit = async (event) => {
    event.preventDefault();
    if (imageLoading || !imageData) {
      agentElement("productError").textContent =
        "Wait for a valid product image preview before saving.";
      return;
    }
    agentElement("saveProduct").disabled = true;
    try {
      await api("/products", {
        method: "POST",
        body: {
          name: agentElement("productName").value,
          description: agentElement("productDescription").value,
          image: imageData,
        },
      });
      imageVersion++;
      imageData = "";
      agentElement("productForm").reset();
      agentElement("productPreview").hidden = true;
      agentElement("productError").textContent = "";
      offset = 0;
      await load();
      toast("Product listed.");
    } catch (error) {
      agentElement("productError").textContent = error.message;
    } finally {
      agentElement("saveProduct").disabled = false;
    }
  };
  await Promise.all([load(), loadPromotions()]);
})();
