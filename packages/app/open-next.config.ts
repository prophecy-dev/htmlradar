import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// No incremental cache: every dashboard page reads D1 per request.
export default defineCloudflareConfig();
