const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const file = path.join(__dirname, "..", ".env");
if (fs.existsSync(file)) {
  console.log("backend/.env already exists; no values were changed.");
} else {
  const template = fs.readFileSync(
    path.join(__dirname, "..", ".env.example"),
    "utf8",
  );
  fs.writeFileSync(
    file,
    template.replace(
      "JWT_SECRET=change-me",
      "JWT_SECRET=" + randomBytes(48).toString("hex"),
    ),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created private backend/.env with a random JWT secret. Set MongoDB, Groq and image API values locally, then run npm start. Never commit this file.",
  );
}
