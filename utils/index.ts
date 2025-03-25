import { Plugin } from "@elizaos/core";
import { authenticateAction, loanInfoAction } from "../actions/index.ts";
import { cooperativesProvider, authStatusProvider } from "../providers/index.ts";
import { cleanupExpiredAuthStates } from "./auth.ts";
import { log } from "./logger.ts";


// Main plugin export
const fusePlugin: Plugin = {
  name: "fuse-plugin",
  description: "Fuse Cooperative Management plugin for Eliza OS",
  
  providers: [cooperativesProvider, authStatusProvider],
  actions: [authenticateAction, loanInfoAction],
};

// Run cleanup every hour
setInterval(() => {
  if (typeof globalThis.runtime !== 'undefined') {
    cleanupExpiredAuthStates(globalThis.runtime);
  }
}, 60 * 60 * 1000);

// Perform API connectivity test on module load
// (async () => {
//   try {
//     log('info', 'Testing Fuse API connectivity');
//     const testResponse = await fetch('https://api.techfsn.com/api/bot/health-check');
//     log('info', `API health check response: ${testResponse.status}`);
    
//     if (testResponse.ok) {
//       log('info', 'Fuse API connection successful');
//     } else {
//       log('warn', `Fuse API connection test failed: ${testResponse.statusText}`);
//     }
//   } catch (error) {
//     log('error', 'Failed to connect to Fuse API during module load', error);
//   }
// })();

export default fusePlugin;