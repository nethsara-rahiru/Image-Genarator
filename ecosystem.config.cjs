module.exports = {
  apps: [
    {
      name: "vps-browser",
      script: "app.js",
      instances: 1,
      exec_mode: "fork",
      kill_timeout: 15000,
      max_memory_restart: "1500M",
      env: { NODE_ENV: "production" },
    },
  ],
};
