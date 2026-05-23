import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
import { config } from "../src/config";
console.log("REPO_EMOJIS:", config.REPO_EMOJIS);
