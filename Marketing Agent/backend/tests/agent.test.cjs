const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const validImage = require("../utils/productImage");

test("product images reject unsafe data and malformed payloads", async () => {
  const { png } = await import("../../../tests/fixtures/png.js");
  assert.equal(
    validImage("data:image/png;base64," + png().toString("base64")),
    true,
  );
  for (const value of [
    null,
    {},
    "https://example.test/image.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,PHNjcmlwdD4=",
    "data:image/png;base64," + "a".repeat(400001),
  ])
    assert.equal(validImage(value), false);
});

test(
  "real Mongo API and browser: owner catalog, promotion composer and saved draft review",
  { skip: !process.env.TEST_MONGODB_URI, timeout: 120000 },
  async (t) => {
    process.env.JWT_SECRET = randomBytes(32).toString("hex");
    const database = "ma_test_" + randomUUID().replaceAll("-", "");
    await mongoose.connect(process.env.TEST_MONGODB_URI, {
      dbName: database,
      serverSelectionTimeoutMS: 10000,
    });
    t.after(async () => {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    const app = require("../app");
    const server = await new Promise((resolve) => {
      const service = app.listen(0, "127.0.0.1", () => resolve(service));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const User = require("../models/User"),
      Profile = require("../models/Profile"),
      Product = require("../models/Product"),
      Post = require("../models/Post");
    const { png } = await import("../../../tests/fixtures/png.js");
    const image = "data:image/png;base64," + png().toString("base64");
    const owner = await User.create({
      name: "Tea Owner",
      email: "owner@example.test",
      role: "owner",
      passwordHash: "test-only",
    });
    const other = await User.create({
      name: "Other Owner",
      email: "other@example.test",
      role: "owner",
      passwordHash: "test-only",
    });
    const customer = await User.create({
      name: "Buyer",
      email: "buyer@example.test",
      role: "customer",
      passwordHash: "test-only",
    });
    const token = (user) =>
      jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, {
        expiresIn: "1h",
      });
    const request = (route, method = "GET", body, user = owner) =>
      fetch(base + "/api" + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(user ? { Cookie: "token=" + token(user) } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    assert.equal((await request("/products", "GET", null, null)).status, 401);
    assert.equal(
      (await request("/products", "GET", null, customer)).status,
      403,
    );
    await Profile.create({
      owner: owner._id,
      name: "Ceylon Tea Studio",
      description: "Locally sourced premium tea for every occasion.",
      logo: image,
      city: "Kandy",
    });
    const created = await request("/products", "POST", {
      name: "Green Tea",
      description: "Fresh loose leaf tea",
      image,
    });
    assert.equal(created.status, 201);
    const product = (await created.json()).product;
    assert.equal(
      (
        await request("/products", "POST", {
          name: "Invalid",
          image: "data:image/svg+xml;base64,PHN2Zz4=",
        })
      ).status,
      400,
    );
    assert.equal((await request("/products?limit=101")).status, 400);
    assert.equal(
      (await (await request("/products", "GET", null, other)).json()).total,
      0,
    );
    assert.equal(
      (await request("/products/" + product._id, "DELETE", null, other)).status,
      404,
    );
    await Profile.create({
      owner: other._id,
      name: "Other Studio",
      description: "A separate business profile for access isolation.",
    });
    assert.equal(
      (
        await request(
          "/posts/draft",
          "POST",
          { targetType: "product", productId: product._id },
          other,
        )
      ).status,
      404,
    );
    const promotion = await request("/posts/draft", "POST", {
      targetType: "product",
      productId: product._id,
      text: "Enjoy Green Tea from Ceylon Tea Studio.",
    });
    assert.equal(promotion.status, 201);
    const draft = (await promotion.json()).post;
    assert.equal(draft.targetName, "Green Tea");
    assert.equal(draft.image, image);
    assert.equal(draft.status, "draft");
    assert.equal(
      (await request("/posts/draft", "POST", { targetType: "business" }))
        .status,
      400,
    );
    assert.equal(
      (
        await request(
          "/posts/" + draft._id,
          "PATCH",
          { status: "approved" },
          other,
        )
      ).status,
      404,
    );
    assert.equal(
      (await request("/products/" + product._id, "DELETE")).status,
      200,
    );
    assert.equal((await Post.findById(draft._id)).image, image);
    await request("/posts/" + draft._id, "PATCH", { status: "rejected" });
    await Product.insertMany(
      Array.from({ length: 23 }, (_, i) => ({
        owner: owner._id,
        name: "Tea " + i,
        description: "Catalog item",
        image,
      })),
    );
    const second = await (await request("/products?limit=20&offset=20")).json();
    assert.equal(second.total, 23);
    assert.equal(second.products.length, 3);

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.TEST_CHROME || undefined,
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.context().addCookies([
      {
        name: "token",
        value: token(owner),
        url: base,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto(base + "/ai-agent.html");
    await page
      .getByRole("button", { name: "Promote Ceylon Tea Studio", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    assert.equal(
      await page
        .getByRole("link", { name: "AI Agent", exact: true })
        .getAttribute("aria-current"),
      "page",
    );
    await page.getByRole("button", { name: "Close menu", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByText("21–23 of 23", { exact: true }).waitFor();
    await page.locator("#agentProducts .agent-promote").first().click();
    assert.ok(
      (await page.locator("#promotionText").inputValue()).includes(
        "Ceylon Tea Studio",
      ),
    );
    assert.equal(
      await page.locator("#promotionImage").getAttribute("src"),
      image,
    );
    await page
      .getByRole("button", { name: "Close promotion composer" })
      .click();
    assert.equal(
      await Post.countDocuments({ owner: owner._id, status: "draft" }),
      0,
    );
    await page
      .getByRole("button", { name: "Promote Ceylon Tea Studio", exact: true })
      .click();
    await page
      .locator("#promotionText")
      .fill("A promotion prepared in the AI Agent composer.");
    await page
      .getByRole("button", { name: "Save promotion draft", exact: true })
      .click();
    await page
      .getByText(
        "Promotion draft saved. Review it in Dashboard before approval.",
        { exact: true },
      )
      .waitFor();
    const saved = await Post.findOne({ owner: owner._id, status: "draft" });
    assert.equal(saved.targetType, "business");
    assert.equal(saved.targetName, "Ceylon Tea Studio");
    await page.goto(base + "/dashboard.html");
    await page.getByText(saved.text, { exact: true }).waitFor();
    assert.equal(
      await page.locator("#postArea img").getAttribute("src"),
      image,
    );
    await page.goto(base + "/ai-agent.html");
    await page
      .getByRole("button", { name: "Promote Ceylon Tea Studio", exact: true })
      .waitFor();
    await page.getByText("Add a product", { exact: true }).click();
    await page.locator("#productName").fill("New Tea");
    await page.locator("#productDescription").fill("A new listed product.");
    await page
      .locator("#productImage")
      .setInputFiles({ name: "tea.png", mimeType: "image/png", buffer: png() });
    await page.locator("#productPreview").waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "List product", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Promote New Tea", exact: true })
      .waitFor();
    const fs = require("node:fs/promises");
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({
      path: "test-results/marketing-agent-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: "test-results/marketing-agent-mobile.png",
      fullPage: true,
    });
    await page.context().clearCookies();
    await page.goto(base + "/ai-agent.html");
    await page.waitForURL("**/login.html");
  },
);
