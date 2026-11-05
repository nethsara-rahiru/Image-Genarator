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
    selection = null,
    imageData = "",
    imageVersion = 0,
    imageLoading = false,
    loadSequence = 0;
  const status = (message) => {
    agentElement("agentStatus").textContent = message;
  };
  function openPromotion(type, product) {
    if (!profile) {
      status("Set up your business profile before preparing a promotion.");
      return;
    }
    selection = {
      targetType: type,
      ...(product ? { productId: product._id } : {}),
    };
    const name = product?.name || profile.name;
    const image = agentImage(product?.image || profile.logo);
    agentElement("promotionTitle").textContent = `Promote ${name}`;
    agentElement("promotionTarget").textContent = product
      ? `${profile.name} · ${product.name}`
      : profile.name;
    agentElement("promotionImage").hidden = !image;
    if (image) agentElement("promotionImage").src = image;
    else agentElement("promotionImage").removeAttribute("src");
    agentElement("promotionText").value = (
      product
        ? `${product.name} from ${profile.name}. ${product.description || ""} Discover more today.`
        : `${profile.name}: ${profile.description} Get in touch to learn more.`
    ).slice(0, 800);
    agentElement("promotionPlatforms").textContent =
      `Preferred platforms: ${(user.preferences?.platforms || []).join(", ") || "None selected. Update Post preferences to choose platforms."}`;
    agentElement("promotionError").textContent = "";
    agentElement("promotionDialog").showModal();
    agentElement("promotionText").focus();
  }
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
  agentElement("closePromotion").onclick = () =>
    agentElement("promotionDialog").close();
  agentElement("promotionForm").onsubmit = async (event) => {
    event.preventDefault();
    if (!selection) return;
    agentElement("savePromotion").disabled = true;
    try {
      await api("/posts/draft", {
        method: "POST",
        body: { ...selection, text: agentElement("promotionText").value },
      });
      agentElement("promotionDialog").close();
      status("Promotion draft saved. Review it in Dashboard before approval.");
      toast("Promotion draft saved.");
    } catch (error) {
      agentElement("promotionError").textContent = error.message;
    } finally {
      agentElement("savePromotion").disabled = false;
    }
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
  await load();
})();
