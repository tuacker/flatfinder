import { loginAndSaveState } from "./session.js";

loginAndSaveState()
  .then(() => {
    console.log("Wohnberatung login successful. Storage state saved.");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
