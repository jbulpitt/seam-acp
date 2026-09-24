// pm2 template for a bridge host. No env and no token here: the bridge reads
// ~/.config/seam/bridge.env itself (#618). Start with
//   pm2 delete seam-bridge; pm2 start ecosystem.config.cjs && pm2 save
const os = require("node:os");
const path = require("node:path");

const home = os.homedir();
const node = path.join(home, ".nvm/versions/node/v22.22.2/bin/node");

module.exports = {
  apps: [
    {
      name: "seam-sessiond",
      script: path.join(home, ".local/libexec/seam-sessiond-launch.sh"),
      interpreter: "bash",
      cwd: home,
      restart_delay: 2000,
      // Stop only sessiond; slots keep running under their holders (#631).
      treekill: false,
    },
    {
      name: "seam-bridge",
      cwd: path.join(home, ".seam/seam-acp"),
      script: "packages/bridge/dist/index.js",
      interpreter: node,
      args: "connect",
      restart_delay: 3000,
      max_restarts: 20,
      kill_timeout: 30000,
    },
  ],
};
