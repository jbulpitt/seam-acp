module.exports = {
  apps: [
    {
      name: "seam-acp",
      script: "dist/index.js",
      cwd: __dirname,
      interpreter: "node",
      // Restart automatically on crash; back off if it crashes repeatedly
      restart_delay: 3000,
      max_restarts: 10,
      // Load .env file values into the process environment
      env_file: ".env",
      // Merge current shell PATH so host CLIs (copilot, gemini, claude) are found
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
      },
    },
  ],
};
