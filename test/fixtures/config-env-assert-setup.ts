// This is intentionally not a dotenv mock: the production import must have
// read the real cwd/.env and overridden the child process's inherited value.
if (process.env.SEAM_495_DOTENV_SENTINEL !== "from-real-dotenv-file") {
  throw new Error("config fixture did not load its real .env with override precedence");
}
