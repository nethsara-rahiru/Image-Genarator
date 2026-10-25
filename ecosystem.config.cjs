module.exports = {
  apps: [
    {
      name: "gemini-api",
      script: "server.js",
      node_args: "--env-file=.env",
      instances: 1,
      exec_mode: "fork",
      kill_timeout: 15000,
      max_memory_restart: "600M",
      env: { NODE_ENV: "production" },
    },
    {
      name: "gemini-worker",
      script: "worker.js",
      node_args: "--env-file=.env",
      instances: 1,
      exec_mode: "fork",
      kill_timeout: 20000,
      max_memory_restart: "1200M",
      env: { NODE_ENV: "production" },
    },
  ],
};
